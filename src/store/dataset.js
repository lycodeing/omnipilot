// 数据集存储（§1.3 / §7.2 / §14.2）：datasets/<name>.jsonl 每行一条记录。
// 行元信息：_id=sha1(内容JSON).slice(0,8)（append 去重用）、_ts、_run、_step。
// upsert 用调用方给的主键（字段名或字段名数组）作 _id（locate_cache 的 <pageId>:<target> 即此形态）。
// 可选 datasets/<name>.schema.json：{ field: 'string'|'number'|'boolean'|'string?'... }，不符即抛错。
// locate_cache.jsonl 也是普通数据集，行形状见 §14.2.1。

import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { applyQuery } from './query.js';

const META_KEYS = ['_id', '_ts', '_run', '_step'];
const TYPES = new Set(['string', 'number', 'boolean']);

// 进程级行缓存（性能）：locate 是全系统最高频调用，旧实现每次 read/upsert 都全量
// 读文件+逐行 JSON.parse，upsert 再全量重写，成本随缓存跨 run 累积线性恶化。
// key = jsonl 绝对路径；以 mtimeMs+size 失效（外部进程写盘也能感知）。
// entry = { mtimeMs, size, rows, indexById, ids }；rows 为权威数组，写路径原地维护。
const ROW_CACHE = new Map();

function assertName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' ||
      name.includes('/') || name.includes('\\')) {
    throw new Error(`数据集名不合法: "${name}"`);
  }
}

function assertRows(rows) {
  if (!Array.isArray(rows)) throw new Error('rows 必须是数组');
  for (const r of rows) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('每行必须是普通对象');
  }
}

// 键序稳定的序列化，保证同内容同哈希
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function contentOf(row) {
  const content = { ...row };
  for (const k of META_KEYS) delete content[k];
  return content;
}

function contentId(row) {
  return crypto.createHash('sha1').update(stableJson(contentOf(row))).digest('hex').slice(0, 8);
}

function finalizeRow(row, id, meta) {
  return {
    _id: id,
    _ts: Date.now(),
    _run: meta?.run ?? null,
    _step: meta?.step ?? null,
    ...contentOf(row),
  };
}

function keyIdentity(key, row) {
  if (key == null || key === '') return contentId(row); // 无主键时退化为内容哈希
  const fields = Array.isArray(key) ? key : [key];
  const parts = fields.map((f) => {
    const v = row[f];
    if (v === undefined) throw new Error(`upsert: 行缺少主键字段 "${f}"`);
    return v === null ? 'null' : typeof v === 'object' ? stableJson(v) : String(v);
  });
  return parts.join(':');
}

async function loadSchema(dataDir, name) {
  const file = path.join(dataDir, `${name}.schema.json`);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name}.schema.json 不是合法 JSON`);
  }
}

// schema 进程级缓存：schema 文件几乎不变，避免每次 append/upsert 付 ENOENT/readFile。
// 键含 dataDir：同名数据集在不同目录（测试/多工作区）的 schema 互不串用。
// 必须按 mtime+size 失效：schema 是用户可编辑的契约文件，用户收紧 schema 后期望后续
// 写入被校验拦截——无失效条件会让缓存永久持有旧 schema，数据质量闸门静默失效。
// （与 ROW_CACHE 同样的失效策略；schema 文件极小，多一次 stat 的成本可忽略。）
const SCHEMA_CACHE = new Map();
async function loadSchemaCached(dataDir, name) {
  const file = path.join(dataDir, `${name}.schema.json`);
  let st = null;
  try {
    st = await stat(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const k = `${dataDir}\u0000${name}`;
  const cached = SCHEMA_CACHE.get(k);
  if (!st) {
    SCHEMA_CACHE.delete(k);
    return null;
  }
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.schema;
  const schema = await loadSchema(dataDir, name);
  SCHEMA_CACHE.set(k, { mtimeMs: st.mtimeMs, size: st.size, schema });
  return schema;
}

function validateSchema(schema, row, label) {
  if (!schema) return;
  for (const [field, typeDecl] of Object.entries(schema)) {
    if (field.startsWith('_')) continue; // 元信息由本层负责
    const optional = typeof typeDecl === 'string' && typeDecl.endsWith('?');
    const base = optional ? typeDecl.slice(0, -1) : typeDecl;
    if (!TYPES.has(base)) throw new Error(`${label}: schema 类型不支持 "${field}: ${typeDecl}"`);
    const v = row[field];
    if (v === undefined || v === null) {
      if (!optional) throw new Error(`${label}: 缺少必填字段 "${field}"`);
      continue;
    }
    if (typeof v !== base) {
      throw new Error(`${label}: 字段 "${field}" 类型应为 ${base}，实际 ${typeof v}`);
    }
  }
}

// 解析 jsonl：坏行跳过而非抛错。
// 写盘路径 append 是非原子的（appendFile），进程在写入中途被杀会留下截断的末行；
// 若此处抛错，整个数据集将永久不可读（只能手工删文件），其余好行也一并丢失。
// 末行截断尤其常见——视为写入中断，丢弃该行；中间坏行同样跳过并计数。
function parseLines(text, name) {
  const rows = [];
  const lines = text.split('\n');
  let bad = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      bad += 1;
    }
  }
  if (bad > 0) {
    console.warn(`[dataset] ${name}.jsonl 有 ${bad} 行不是合法 JSON（写入中断或损坏），已跳过；建议用 data clear 重建`);
  }
  return rows;
}

// 带缓存的行读取：mtimeMs+size 未变则直接返回缓存数组（调用方不得 mutate，
// 需要副本时自行 slice/copy）。外部写盘（其它进程/手工编辑）会因 mtime/size 变化失效。
async function readRowsCached(dataDir, name) {
  const file = path.join(dataDir, `${name}.jsonl`);
  const cached = ROW_CACHE.get(file);
  let st = null;
  try {
    st = await stat(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (!st) {
    ROW_CACHE.delete(file);
    return [];
  }
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.rows;
  const text = await readFile(file, 'utf8');
  const rows = parseLines(text, name);
  const indexById = new Map();
  const ids = new Set();
  for (let i = 0; i < rows.length; i++) {
    const id = rows[i]?._id;
    if (id === undefined) continue;
    ids.add(id);
    if (!indexById.has(id)) indexById.set(id, i);
  }
  const entry = { mtimeMs: st.mtimeMs, size: st.size, rows, indexById, ids };
  ROW_CACHE.set(file, entry);
  return rows;
}

// 写后登记缓存：避免下一次读再付 stat+readFile
function commitCache(dataDir, name, entry) {
  const file = path.join(dataDir, `${name}.jsonl`);
  ROW_CACHE.set(file, entry);
}

function invalidateCache(dataDir, name) {
  ROW_CACHE.delete(path.join(dataDir, `${name}.jsonl`));
}

async function readRows(dataDir, name) {
  return readRowsCached(dataDir, name);
}

async function writeRowsAtomic(file, rows) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const text = rows.length ? rows.map((r) => JSON.stringify(r)).join('\n') + '\n' : '';
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
  ROW_CACHE.delete(file);
}

// 进程内 per-file 串行锁：append（增量追加）与 upsert/clear（全量重写）都用"读快照→写"，
// 并发交错时全量重写方会用陈旧快照覆盖增量落盘内容（实测：并发 upsert 合并值被静默丢弃）。
// 锁粒度为文件路径；同进程内所有写操作排队，跨进程仍靠 tmp+rename 原子性与内容 _id 去重兜底。
const FILE_LOCKS = new Map(); // file → 末尾 Promise（链式排队）

function withFileLock(file, fn) {
  const prev = FILE_LOCKS.get(file) ?? Promise.resolve();
  const run = prev.then(fn, fn); // 前序失败不阻断后续
  // 链尾保存"已 settle"的 Promise，避免链无限增长持有 rejection
  FILE_LOCKS.set(file, run.then(() => {}, () => {}));
  return run;
}

export function openDataset({ dataDir = 'datasets' } = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('openDataset 需要 dataDir 目录');
  let dirReady = false;
  async function ensureDir() {
    if (dirReady) return;
    await mkdir(dataDir, { recursive: true });
    dirReady = true;
  }

  async function append(name, rows, meta = {}) {
    assertName(name);
    assertRows(rows);
    const schema = await loadSchemaCached(dataDir, name);
    for (const row of rows) validateSchema(schema, row, `${name}.jsonl append`);
    if (!rows.length) return { written: 0 };
    await ensureDir();
    const file = path.join(dataDir, `${name}.jsonl`);
    // 读快照→写 必须在文件锁内（与 upsert/clear 互斥，防陈旧快照覆盖并发写）
    return withFileLock(file, async () => {
      const existing = await readRowsCached(dataDir, name);
      const seen = ROW_CACHE.get(file)?.ids ?? new Set(existing.map((r) => r?._id).filter(Boolean));
      const lines = [];
      const added = [];
      for (const row of rows) {
        const id = contentId(row);
        if (seen.has(id)) continue; // 内容去重（§14.2 滚动采集）
        seen.add(id);
        const final = finalizeRow(row, id, meta);
        added.push(final);
        lines.push(JSON.stringify(final));
      }
      if (lines.length) {
        try {
          await appendFile(file, lines.join('\n') + '\n', 'utf8');
        } catch (e) {
          invalidateCache(dataDir, name); // 写失败：缓存已原地 mutate，必须失效回磁盘真相
          throw e;
        }
        // 缓存原地维护：rows 追加、indexById/ids 更新；mtime/size 同步到刚写完的状态
        const st = await stat(file).catch(() => null);
        const entry = ROW_CACHE.get(file) ?? { rows: [...existing], indexById: new Map(), ids: new Set() };
        for (const row of added) {
          if (row._id !== undefined) {
            entry.ids.add(row._id); // 去重集合必须同步，否则同内容 append 会重复写入
            if (!entry.indexById.has(row._id)) entry.indexById.set(row._id, entry.rows.length);
          }
          entry.rows.push(row);
        }
        entry.mtimeMs = st?.mtimeMs ?? Date.now();
        entry.size = st?.size ?? 0;
        commitCache(dataDir, name, entry);
      }
      return { written: lines.length };
    });
  }

  async function upsert(name, key, rows, meta = {}) {
    assertName(name);
    assertRows(rows);
    const schema = await loadSchemaCached(dataDir, name);
    for (const row of rows) validateSchema(schema, row, `${name}.jsonl upsert`);
    if (!rows.length) return { written: 0, merged: 0 };
    await ensureDir();
    const file = path.join(dataDir, `${name}.jsonl`);
    // 读快照→（可能）全量重写 必须在文件锁内：否则会用陈旧快照覆盖并发 append 的内容
    return withFileLock(file, async () => {
      const existing = await readRowsCached(dataDir, name);
      const entry = ROW_CACHE.get(file);
      const indexById = entry?.indexById ?? new Map();
      if (!entry) {
        existing.forEach((r, i) => {
          if (r && r._id !== undefined && !indexById.has(r._id)) indexById.set(r._id, i);
        });
      }
      let written = 0;
      let merged = 0;
      const appendedLines = [];
      for (const row of rows) {
        const id = keyIdentity(key, row);
        const final = finalizeRow(row, id, meta);
        if (indexById.has(id)) {
          existing[indexById.get(id)] = final; // 原位替换，保持行序稳定
          merged++;
        } else {
          indexById.set(id, existing.length);
          if (entry) entry.ids.add(id);
          existing.push(final);
          appendedLines.push(JSON.stringify(final));
          written++;
        }
      }
      if (merged > 0) {
        // 有原位替换：必须全量重写保持行序（语义不变）
        try {
          await writeRowsAtomic(file, existing);
        } catch (e) {
          invalidateCache(dataDir, name);
          throw e;
        }
        const st = await stat(file).catch(() => null);
        const e = { mtimeMs: st?.mtimeMs ?? Date.now(), size: st?.size ?? 0, rows: existing, indexById, ids: new Set(indexById.keys()) };
        commitCache(dataDir, name, e);
      } else if (appendedLines.length) {
        // 纯新增：append-only，避免全量重写
        try {
          await appendFile(file, appendedLines.join('\n') + '\n', 'utf8');
        } catch (e) {
          invalidateCache(dataDir, name);
          throw e;
        }
        const st = await stat(file).catch(() => null);
        const e = entry ?? { rows: existing, indexById, ids: new Set(indexById.keys()) };
        e.mtimeMs = st?.mtimeMs ?? Date.now();
        e.size = st?.size ?? 0;
        commitCache(dataDir, name, e);
      }
      return { written, merged };
    });
  }

  return {
    append,
    upsert,
    read: (name) => {
      assertName(name);
      return readRowsCached(dataDir, name);
    },
    clear: async (name) => {
      assertName(name);
      const file = path.join(dataDir, `${name}.jsonl`);
      // 删除同样进锁：否则并发 append 可能在 rm 之后又把旧数据追加回已清空的数据集
      await withFileLock(file, async () => {
        await rm(file, { force: true });
        invalidateCache(dataDir, name);
      });
    },
    query: async (name, opts = {}) => {
      assertName(name);
      return applyQuery(await readRowsCached(dataDir, name), opts);
    },
  };
}
