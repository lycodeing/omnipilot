// 数据集存储（§1.3 / §7.2 / §14.2）：datasets/<name>.jsonl 每行一条记录。
// 行元信息：_id=sha1(内容JSON).slice(0,8)（append 去重用）、_ts、_run、_step。
// upsert 用调用方给的主键（字段名或字段名数组）作 _id（locate_cache 的 <pageId>:<target> 即此形态）。
// 可选 datasets/<name>.schema.json：{ field: 'string'|'number'|'boolean'|'string?'... }，不符即抛错。
// locate_cache.jsonl 也是普通数据集，行形状见 §14.2.1。

import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { applyQuery } from './query.js';

const META_KEYS = ['_id', '_ts', '_run', '_step'];
const TYPES = new Set(['string', 'number', 'boolean']);

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

async function readRows(dataDir, name) {
  const file = path.join(dataDir, `${name}.jsonl`);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const rows = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error(`${name}.jsonl 第 ${i + 1} 行不是合法 JSON`);
    }
  }
  return rows;
}

async function writeRowsAtomic(file, rows) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const text = rows.length ? rows.map((r) => JSON.stringify(r)).join('\n') + '\n' : '';
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

export function openDataset({ dataDir = 'datasets' } = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('openDataset 需要 dataDir 目录');

  async function append(name, rows, meta = {}) {
    assertName(name);
    assertRows(rows);
    const schema = await loadSchema(dataDir, name);
    for (const row of rows) validateSchema(schema, row, `${name}.jsonl append`);
    if (!rows.length) return { written: 0 };
    await mkdir(dataDir, { recursive: true });
    const seen = new Set((await readRows(dataDir, name)).map((r) => r?._id).filter(Boolean));
    const lines = [];
    for (const row of rows) {
      const id = contentId(row);
      if (seen.has(id)) continue; // 内容去重（§14.2 滚动采集）
      seen.add(id);
      lines.push(JSON.stringify(finalizeRow(row, id, meta)));
    }
    if (lines.length) {
      await appendFile(path.join(dataDir, `${name}.jsonl`), lines.join('\n') + '\n', 'utf8');
    }
    return { written: lines.length };
  }

  async function upsert(name, key, rows, meta = {}) {
    assertName(name);
    assertRows(rows);
    const schema = await loadSchema(dataDir, name);
    for (const row of rows) validateSchema(schema, row, `${name}.jsonl upsert`);
    if (!rows.length) return { written: 0, merged: 0 };
    await mkdir(dataDir, { recursive: true });
    const file = path.join(dataDir, `${name}.jsonl`);
    const existing = await readRows(dataDir, name);
    const indexById = new Map();
    existing.forEach((r, i) => {
      if (r && r._id !== undefined && !indexById.has(r._id)) indexById.set(r._id, i);
    });
    let written = 0;
    let merged = 0;
    for (const row of rows) {
      const id = keyIdentity(key, row);
      const final = finalizeRow(row, id, meta);
      if (indexById.has(id)) {
        existing[indexById.get(id)] = final; // 原位替换，保持行序稳定
        merged++;
      } else {
        indexById.set(id, existing.length);
        existing.push(final);
        written++;
      }
    }
    await writeRowsAtomic(file, existing);
    return { written, merged };
  }

  return {
    append,
    upsert,
    read: (name) => {
      assertName(name);
      return readRows(dataDir, name);
    },
    clear: async (name) => {
      assertName(name);
      await rm(path.join(dataDir, `${name}.jsonl`), { force: true });
    },
    query: async (name, opts = {}) => {
      assertName(name);
      return applyQuery(await readRows(dataDir, name), opts);
    },
  };
}
