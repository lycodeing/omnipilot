// query.js 纯函数测试：where 各操作符、&& 组合、orderBy、limit、select

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyQuery, matchesWhere } from '../src/store/query.js';

const rows = [
  { _id: 'a1', n: 1, name: '春游', d: '2025-09-16', flag: true },
  { _id: 'b2', n: 2, name: '秋游', d: '2025-01-02', flag: false },
  { _id: 'c3', n: 3, name: '春游', d: '2025-06-30', flag: true },
  { _id: 'd4', n: 4, name: '冬游', d: '2025-12-01', flag: false },
];

test('where > 按数字比较', () => {
  assert.deepEqual(applyQuery(rows, { where: 'n>2' }).map((r) => r._id), ['c3', 'd4']);
});

test('where < 按数字比较', () => {
  assert.deepEqual(applyQuery(rows, { where: 'n<3' }).map((r) => r._id), ['a1', 'b2']);
});

test('where = 字符串等值', () => {
  assert.deepEqual(applyQuery(rows, { where: 'name=春游' }).map((r) => r._id), ['a1', 'c3']);
});

test('where = 数字字面量与数字行值收敛比较', () => {
  assert.deepEqual(applyQuery(rows, { where: 'n=3' }).map((r) => r._id), ['c3']);
});

test('where != 排除', () => {
  assert.deepEqual(applyQuery(rows, { where: 'name!=春游' }).map((r) => r._id), ['b2', 'd4']);
});

test('where 布尔字面量', () => {
  assert.deepEqual(applyQuery(rows, { where: 'flag=true' }).map((r) => r._id), ['a1', 'c3']);
  assert.deepEqual(applyQuery(rows, { where: 'flag=false' }).map((r) => r._id), ['b2', 'd4']);
});

test('where 字符串日期按字典序比较（ISO 格式可用）', () => {
  assert.deepEqual(applyQuery(rows, { where: 'd>2025-06-30' }).map((r) => r._id), ['a1', 'd4']);
});

test('where && 组合', () => {
  assert.deepEqual(applyQuery(rows, { where: 'n>1 && name!=秋游' }).map((r) => r._id), ['c3', 'd4']);
});

test('where 缺失字段：= 不命中、!= 命中', () => {
  assert.equal(matchesWhere({ n: 1 }, 'missing=1'), false);
  assert.equal(matchesWhere({ n: 1 }, 'missing!=1'), true);
});

test('where 非法子句抛错', () => {
  assert.throws(() => applyQuery(rows, { where: 'n >> 2' }), /不合法/);
  assert.throws(() => applyQuery(rows, { where: 'n == 2' }), /不合法/);
  assert.throws(() => applyQuery(rows, { where: 'n>' }), /不合法/);
  assert.throws(() => applyQuery(rows, { where: 'n>2 && junk' }), /不合法/);
  assert.throws(() => applyQuery(rows, { where: 42 }), /字符串/);
});

test('orderBy 升序 / -降序', () => {
  assert.deepEqual(applyQuery(rows, { orderBy: 'n' }).map((r) => r._id), ['a1', 'b2', 'c3', 'd4']);
  assert.deepEqual(applyQuery(rows, { orderBy: '-n' }).map((r) => r._id), ['d4', 'c3', 'b2', 'a1']);
});

test('orderBy 字符串字段（按 UTF-16 码元：冬<春<秋）', () => {
  assert.deepEqual(applyQuery(rows, { orderBy: 'name' }).map((r) => r._id), ['d4', 'a1', 'c3', 'b2']);
  assert.deepEqual(applyQuery(rows, { orderBy: '-d' }).map((r) => r._id), ['d4', 'a1', 'c3', 'b2']);
});

test('orderBy 缺失字段排最后，稳定排序保持原相对顺序', () => {
  const base = [{ n: 2 }, { n: 1, k: 1 }, { n: 1, k: 2 }];
  assert.deepEqual(applyQuery(base, { orderBy: 'n' }), [{ n: 1, k: 1 }, { n: 1, k: 2 }, { n: 2 }]);
  assert.deepEqual(applyQuery([{ a: 1 }, { a: 2 }], { orderBy: 'zzz' }), [{ a: 1 }, { a: 2 }]);
});

test('limit 截断（在 orderBy 之后生效）', () => {
  assert.deepEqual(applyQuery(rows, { orderBy: '-n', limit: 2 }).map((r) => r._id), ['d4', 'c3']);
  assert.equal(applyQuery(rows, { limit: 0 }).length, 0);
  assert.equal(applyQuery(rows, {}).length, 4);
});

test('select 投影指定列（含元字段需显式选择）', () => {
  assert.deepEqual(applyQuery(rows, { select: ['name'] }), [{ name: '春游' }, { name: '秋游' }, { name: '春游' }, { name: '冬游' }]);
  const one = applyQuery(rows, { select: ['_id', 'n'], limit: 1 })[0];
  assert.deepEqual(one, { _id: 'a1', n: 1 });
});

test('select 非数组抛错', () => {
  assert.throws(() => applyQuery(rows, { select: 'name' }), /数组/);
});

test('不修改入参数组', () => {
  const input = [{ n: 2 }, { n: 1 }];
  applyQuery(input, { orderBy: 'n' });
  assert.deepEqual(input.map((r) => r.n), [2, 1]);
});

test('嵌套字段路径可用', () => {
  const nested = [{ meta: { step: 1 }, v: 'x' }, { meta: { step: 2 }, v: 'y' }];
  assert.deepEqual(applyQuery(nested, { where: 'meta.step=2' }).map((r) => r.v), ['y']);
});
