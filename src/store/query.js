// 数据集查询纯函数（§13.2 / §1.3）：
// where 支持 'field>lit' / 'field<lit' / 'field=lit' / 'field!=lit'，可用 '&&' 组合；
// orderBy 'field' 升序 / '-field' 降序；limit 截断；select 列投影。
// 语义：字面量类型以行内实际值的类型为准做收敛（数字行值按数字比较，其余按字符串比较）。

function getByPath(obj, path) {
  let cur = obj;
  for (const key of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

// 顺序敏感：!= 必须先于 = 参与匹配
const CLAUSE_RE = /^([A-Za-z_$][\w$.]*)\s*(!=|=|>|<)\s*(.*)$/;

function parseClause(text) {
  const m = String(text).trim().match(CLAUSE_RE);
  const lit = m ? m[3].trim() : null;
  if (!m || !lit || /^[=!<>]/.test(lit)) {
    // 拦截 'n >> 2' / 'n == 2' 这类被前缀吞掉的非法子句
    throw new Error(`query.where 子句不合法: "${text}"`);
  }
  return { field: m[1], op: m[2], lit };
}

function parseWhere(where) {
  if (where == null || where === '') return [];
  if (typeof where !== 'string') throw new Error('query.where 必须是字符串表达式');
  return where
    .split('&&')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseClause);
}

function coerceLiteral(lit, actual) {
  if (typeof actual === 'number') {
    const n = Number(lit);
    if (Number.isFinite(n)) return n;
  } else if (typeof actual === 'boolean') {
    if (lit === 'true') return true;
    if (lit === 'false') return false;
  }
  return lit;
}

function matchClause(row, { field, op, lit }) {
  const actual = getByPath(row, field);
  if (actual == null) return op === '!='; // 字段缺失/为 null：仅 != 视为命中
  const expected = coerceLiteral(lit, actual);
  switch (op) {
    case '=':
      return actual === expected;
    case '!=':
      return actual !== expected;
    case '>':
      return actual > expected;
    case '<':
      return actual < expected;
    default:
      throw new Error(`不支持的操作符: ${op}`);
  }
}

function compareValues(a, b) {
  if (a === b) return 0;
  if (a == null) return 1; // 缺失值排最后（升序）
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// where 编译缓存：同一 where 字符串只解析一次（旧实现导出的 matchesWhere 每行重解析）。
// 上限防泄漏；键为 where 原文。
const WHERE_CACHE = new Map();
const WHERE_CACHE_MAX = 100;
export function compileWhere(where) {
  if (where == null || where === '') return [];
  const hit = WHERE_CACHE.get(where);
  if (hit) return hit;
  const clauses = parseWhere(where);
  if (WHERE_CACHE.size >= WHERE_CACHE_MAX) WHERE_CACHE.clear();
  WHERE_CACHE.set(where, clauses);
  return clauses;
}

export function matchesWhere(row, where) {
  return compileWhere(where).every((clause) => matchClause(row, clause));
}

export function applyQuery(rows, { where, select, limit, orderBy } = {}) {
  if (!Array.isArray(rows)) throw new Error('applyQuery: rows 必须是数组');
  let out = rows.slice(); // 不改入参

  const clauses = compileWhere(where);
  const hasLimit = limit != null && Number.isFinite(Number(limit));
  const n = hasLimit ? Math.max(0, Math.floor(Number(limit))) : Infinity;
  if (clauses.length) {
    if (orderBy == null || orderBy === '') {
      // 无排序时命中 limit 条即可提前停（旧实现全量 filter）
      const picked = [];
      for (const row of out) {
        if (clauses.every((c) => matchClause(row, c))) {
          picked.push(row);
          if (picked.length >= n) break;
        }
      }
      out = picked;
    } else {
      out = out.filter((row) => clauses.every((c) => matchClause(row, c)));
    }
  }

  if (orderBy != null && orderBy !== '') {
    const text = String(orderBy);
    const desc = text.startsWith('-');
    const field = desc ? text.slice(1) : text;
    if (!field) throw new Error(`query.orderBy 不合法: "${orderBy}"`);
    out.sort((a, b) => {
      const r = compareValues(getByPath(a, field), getByPath(b, field));
      return desc ? -r : r;
    });
  }

  if (hasLimit) out = out.slice(0, n);

  if (select != null) {
    if (!Array.isArray(select) || select.some((f) => typeof f !== 'string')) {
      throw new Error('query.select 必须是字段名数组');
    }
    out = out.map((row) => Object.fromEntries(select.map((f) => [f, getByPath(row, f)])));
  }

  return out;
}
