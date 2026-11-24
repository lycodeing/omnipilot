// dataset.js 测试：append/upsert 去重、_id 语义、schema 校验（含可选类型失败抛错）、clear、
// locate_cache.jsonl 行形状（§14.2.1）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDataset } from '../src/store/dataset.js';

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('append 补元信息并落 JSONL，read 回读一致', async (t) => {
  const dir = tmpDir(t, 'ask-ds-');
  const ds = openDataset({ dataDir: dir });
  const { written } = await ds.append('albums', [{ album_name: '春游', album_date: '2025-09-16' }], { run: 'run-1', step: 7 });
  assert.equal(written, 1);
  const rows = await ds.read('albums');
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.match(row._id, /^[0-9a-f]{8}$/);
  assert.equal(typeof row._ts, 'number');
  assert.equal(row._run, 'run-1');
  assert.equal(row._step, 7);
  assert.equal(row.album_name, '春游');
  assert.equal(row.album_date, '2025-09-16');
  assert.equal(fs.readFileSync(path.join(dir, 'albums.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1);
});

test('_id 是内容哈希：同内容去重，改内容才新增', async (t) => {
  const dir = tmpDir(t, 'ask-ds-');
  const ds = openDataset({ dataDir: dir });
  const row = { album_name: '春游', album_date: '2025-09-16' };
  await ds.append('albums', [row], { run: 'run-1', step: 1 });
  // 同内容不同 meta/时间戳 → 仍去重
  assert.equal((await ds.append('albums', [{ ...row }], { run: 'run-2', step: 2 })).written, 0);
  assert.equal((await ds.read('albums')).length, 1);
  // 内容变化 → 新增
  assert.equal((await ds.append('albums', [{ ...row, album_date: '2025-09-17' }], { run: 'run-2', step: 3 })).written, 1);
  assert.equal((await ds.read('albums')).length, 2);
  // 键序不同但内容相同 → 同一哈希
  assert.equal((await ds.append('albums', [{ album_date: '2025-09-16', album_name: '春游' }])).written, 0);
  // _id 只由内容决定，与元信息无关
  const ds2 = openDataset({ dataDir: tmpDir(t, 'ask-ds-') });
  await ds2.append('x', [row], { run: 'run-9', step: 9 });
  const ds3 = openDataset({ dataDir: tmpDir(t, 'ask-ds-') });
  await ds3.append('x', [row], { run: 'run-0', step: 0 });
  assert.equal(
    (await ds2.read('x'))[0]._id,
    (await ds3.read('x'))[0]._id,
  );
});

test('upsert 单字段主键：新行 written、旧行 merged 原位替换', async (t) => {
  const dir = tmpDir(t, 'ask-ds-');
  const ds = openDataset({ dataDir: dir });
  let r = await ds.upsert('albums', 'album_name', [{ album_name: '春游', album_date: '2025-09-16' }], { run: 'run-1', step: 1 });
  assert.deepEqual(r, { written: 1, merged: 0 });
  r = await ds.upsert('albums', 'album_name', [{ album_name: '春游', album_date: '2025-09-17' }], { run: 'run-1', step: 2 });
  assert.deepEqual(r, { written: 0, merged: 1 });
  await ds.upsert('albums', 'album_name', [{ album_name: '秋游', album_date: '2025-10-01' }], { run: 'run-1', step: 3 });
  const rows = await ds.read('albums');
  assert.equal(rows.length, 2);
  assert.equal(rows[0]._id, '春游'); // _id 即主键值
  assert.equal(rows[0].album_date, '2025-09-17');
  assert.equal(rows[0]._step, 2);
  assert.equal(rows[0]._run, 'run-1');
});

test('upsert 复合主键承载 locate_cache.jsonl 行形状（§14.2.1）', async (t) => {
  const dir = tmpDir(t, 'ask-ds-');
  const ds = openDataset({ dataDir: dir });
  const base = {
    pageId: 'pages/childhood/album',
    target: '电子相册',
    strategy: 'exact_text',
    bounds: [512, 760, 704, 880],
    screenSize: '720x1280',
    identity: { text: '电子相册', resourceId: 'com.lgdg:id/album', class: 'android.widget.TextView' },
    hits: 1,
    lastHitAt: 1750000000000,
    invalidAt: null,
  };
  await ds.upsert('locate_cache', ['pageId', 'target'], [{ ...base }], { run: 'run-x', step: 3 });
  // 第二次 upsert：同键 merged，hits 更新
  const r = await ds.upsert('locate_cache', ['pageId', 'target'], [{ ...base, hits: 7, lastHitAt: 1750000050000 }], { run: 'run-y', step: 4 });
  assert.deepEqual(r, { written: 0, merged: 1 });
  const rows = await ds.read('locate_cache');
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row._id, 'pages/childhood/album:电子相册'); // <pageId>:<target>
  for (const key of ['_id', '_ts', '_run', '_step', 'pageId', 'target', 'strategy', 'bounds', 'screenSize', 'identity', 'hits', 'lastHitAt', 'invalidAt']) {
    assert.ok(key in row, `缺少字段 ${key}`);
  }
  assert.equal(row.hits, 7);
  assert.equal(row._run, 'run-y');
  assert.deepEqual(row.bounds, [512, 760, 704, 880]);
  assert.deepEqual(row.identity, { text: '电子相册', resourceId: 'com.lgdg:id/album', class: 'android.widget.TextView' });
});

test('schema 校验：可选类型缺省通过、类型不符抛错、缺必填抛错', async (t) => {
  const dir = tmpDir(t, 'ask-ds-');
  const ds = openDataset({ dataDir: dir });
  fs.writeFileSync(path.join(dir, 'albums.schema.json'),
    JSON.stringify({ album_name: 'string', album_date: 'string', photo_count: 'number?' }));
  // 可选字段缺省 → 通过
  await ds.append('albums', [{ album_name: '春游', album_date: '2025-09-16' }]);
  // 可选字段类型不符 → 抛错
  await assert.rejects(
    () => ds.append('albums', [{ album_name: '春游', album_date: '2025-09-16', photo_count: '3' }]),
    /photo_count.*number/,
  );
  // 必填缺失 → 抛错
  await assert.rejects(() => ds.append('albums', [{ album_name: '春游' }]), /必填字段/);
  // 必填类型不符 → 抛错
  await assert.rejects(
    () => ds.append('albums', [{ album_name: 123, album_date: '2025-09-16' }]),
    /album_name.*string/,
  );
  // upsert 同样受 schema 约束
  await assert.rejects(
    () => ds.upsert('albums', 'album_name', [{ album_name: '春游', album_date: '2025-09-16', photo_count: true }]),
    /photo_count/,
  );
  // 合法可选值 → 通过
  await ds.append('albums', [{ album_name: '秋游', album_date: '2025-10-01', photo_count: 12 }]);
  // 未定义 schema 的字段放行
  await ds.append('albums', [{ album_name: '冬游', album_date: '2025-12-01', extra: { any: 'thing' } }]);
});

test('schema 布尔类型与非法类型声明', async (t) => {
  const dir = tmpDir(t, 'ask-ds-');
  const ds = openDataset({ dataDir: dir });
  fs.writeFileSync(path.join(dir, 'flags.schema.json'), JSON.stringify({ ok: 'boolean', note: 'string?' }));
  await ds.append('flags', [{ ok: true }]);
  await assert.rejects(() => ds.append('flags', [{ ok: 'yes' }]), /ok.*boolean/);
  await ds.append('flags', [{ ok: false, note: null }]);
  fs.writeFileSync(path.join(dir, 'bad.schema.json'), JSON.stringify({ x: 'float' }));
  await assert.rejects(() => ds.append('bad', [{ x: 1 }]), /类型不支持/);
});

test('clear 删除数据文件；read 不存在的数据集返回空数组', async (t) => {
  const dir = tmpDir(t, 'ask-ds-');
  const ds = openDataset({ dataDir: dir });
  assert.deepEqual(await ds.read('nothing'), []);
  await ds.append('albums', [{ album_name: '春游', album_date: '2025-09-16' }]);
  await ds.clear('albums');
  assert.deepEqual(await ds.read('albums'), []);
  assert.equal(fs.existsSync(path.join(dir, 'albums.jsonl')), false);
  await ds.clear('never-existed'); // 幂等不抛
  // schema 文件不属于数据，clear 不动它
  fs.writeFileSync(path.join(dir, 's.schema.json'), JSON.stringify({ a: 'string' }));
  await ds.append('s', [{ a: 'x' }]);
  await ds.clear('s');
  assert.equal(fs.existsSync(path.join(dir, 's.schema.json')), true);
});

test('query 委托：where/orderBy/limit/select 全链路', async (t) => {
  const dir = tmpDir(t, 'ask-ds-');
  const ds = openDataset({ dataDir: dir });
  await ds.append('albums', [
    { album_name: '春游', album_date: '2025-09-16' },
    { album_name: '秋游', album_date: '2025-10-01' },
    { album_name: '冬游', album_date: '2025-12-01' },
  ], { run: 'run-1', step: 1 });
  const out = await ds.query('albums', {
    where: 'album_date>2025-09-01',
    orderBy: '-album_date',
    limit: 2,
    select: ['album_name', '_step'],
  });
  assert.deepEqual(out, [
    { album_name: '冬游', _step: 1 },
    { album_name: '秋游', _step: 1 },
  ]);
});

test('非法输入：数据集名与行形状', async (t) => {
  const dir = tmpDir(t, 'ask-ds-');
  const ds = openDataset({ dataDir: dir });
  await assert.rejects(() => ds.append('../evil', [{ a: 1 }]), /不合法/);
  await assert.rejects(() => ds.append('ok', 'not-array'), /数组/);
  await assert.rejects(() => ds.append('ok', [[1, 2]]), /普通对象/);
  await assert.rejects(() => ds.upsert('ok', 'k', [{ other: 1 }]), /主键字段/);
});

test('并发 append 与 upsert 交错：增量零丢失、upsert 不丢、磁盘与缓存一致（文件锁回归）', async (t) => {
  // 回归（2026-11-02）：append 走增量追加、upsert 走全量重写，两者都"读快照→写"，
  // 无互斥时全量重写方用陈旧快照覆盖并发追加内容（实测静默丢写）。
  const dir = tmpDir(t, 'ds-race-');
  const store = openDataset({ dataDir: dir });
  await store.append('t', [{ k: 'a', v: 1 }]);
  for (let i = 0; i < 5; i++) {
    await Promise.all([
      store.append('t', Array.from({ length: 20 }, (_, j) => ({ k: `app${i}-${j}`, v: j }))),
      store.upsert('t', 'k', [{ k: 'a', v: 999 + i }]),
    ]);
  }
  const rows = await store.read('t');
  const diskLines = fs.readFileSync(path.join(dir, 't.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  assert.equal(rows.filter((r) => String(r.k).startsWith('app')).length, 100, 'append 100 行零丢失');
  assert.ok(rows.some((r) => r.k === 'a' && r.v >= 999), 'upsert 行存在');
  assert.equal(diskLines, rows.length, '磁盘行数与缓存一致');
});

test('并发 clear 与 append：清除后不再有旧数据复活', async (t) => {
  const dir = tmpDir(t, 'ds-clear-');
  const store = openDataset({ dataDir: dir });
  await store.append('t', Array.from({ length: 10 }, (_, i) => ({ k: `old${i}` })));
  await Promise.all([store.clear('t'), store.append('t', [{ k: 'new1' }])]);
  const rows = await store.read('t');
  // 顺序不定：要么清空后只剩 new1，要么先 append 再清空（0 行）——但绝不该出现 10 条 old
  assert.ok(rows.filter((r) => String(r.k).startsWith('old')).length === 0 || rows.length === 0,
    `旧数据不得复活（实际 ${rows.length} 行）`);
});

test('坏行跳过而非摧毁整个数据集：末行截断（写入中断）时其余行仍可读', async (t) => {
  // 回归用例：append 走非原子 appendFile，进程中途被杀会留下截断的末行。
  // 原实现对坏行直接 throw → 该数据集此后永久不可读（只能手工删文件）。
  const dir = tmpDir(t, 'ask-ds-bad-');
  const ds = openDataset({ dataDir: dir });
  await ds.append('t', [{ v: 1 }, { v: 2 }]);
  // 手工模拟写入中断：追加半行
  fs.appendFileSync(path.join(dir, 't.jsonl'), '{"v":3,"_id":"x');
  const rows = await ds.read('t');
  assert.equal(rows.length, 2, '好行应全部可读');
  assert.deepEqual(rows.map((r) => r.v), [1, 2]);
});

test('中间坏行也跳过：不影响前后好行', async (t) => {
  const dir = tmpDir(t, 'ask-ds-bad2-');
  const ds = openDataset({ dataDir: dir });
  await ds.append('t', [{ v: 1 }, { v: 2 }]);
  const file = path.join(dir, 't.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(file, [lines[0], '{坏行', lines[1]].join('\n') + '\n');
  const rows = await ds.read('t');
  assert.equal(rows.length, 2, '坏行不应摧毁其余行');
});
