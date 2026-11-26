// yadb 输入（§5.4.5）：命令拼装 / 单引号转义 / 首推+chmod / keyboardClear→keyboard 序列
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Adb } from '../src/device/adb.js';
import {
  shellQuote,
  yadbKeyboardCommand,
  yadbClearCommand,
  Yadb,
  findNodeAtPoint,
  readTextAt,
  YADB_REMOTE,
} from '../src/device/input.js';

test('shellQuote：单引号包裹与转义', () => {
  assert.equal(shellQuote('abc'), `'abc'`);
  assert.equal(shellQuote('学A吧2026'), `'学A吧2026'`);
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote('a b-c_1'), `'a b-c_1'`);
});

test('yadb 命令形状（§5.4.5 app_process 调用）', () => {
  const remote = '/data/local/tmp/yadb';
  assert.equal(
    yadbKeyboardCommand(remote, '学A吧2026'),
    `app_process -Djava.class.path=/data/local/tmp/yadb /data/local/tmp com.ysbing.yadb.Main -keyboard '学A吧2026'`
  );
  assert.equal(
    yadbClearCommand(remote),
    'app_process -Djava.class.path=/data/local/tmp/yadb /data/local/tmp com.ysbing.yadb.Main -keyboardClear'
  );
  assert.equal(yadbKeyboardCommand(remote, "it'x").includes(`-keyboard 'it'\\''x'`), true);
});

test('Yadb：未推送时 push+chmod 一次，之后复用（注入假 adb 执行器）', async () => {
  const calls = [];
  const adb = new Adb({
    serial: 'test',
    exec: async (args) => {
      const joined = args.join(' ');
      calls.push(joined);
      if (joined.includes('ls /data/local/tmp/yadb')) return { code: 1, stdout: '', stderr: 'No such file' };
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  const yadb = new Yadb(adb, { localPath: 'VENDOR/yadb' });
  await yadb.type('中文');
  await yadb.clear();
  await yadb.type('第二次');
  const pushIdx = calls.findIndex((c) => c.includes('push VENDOR/yadb /data/local/tmp/yadb'));
  assert.notEqual(pushIdx, -1, '首次必须推送 vendor/yadb');
  assert.ok(calls[pushIdx + 1].includes('chmod 755'), '推送后 chmod');
  assert.equal(calls.filter((c) => c.includes('push ')).length, 1, '只推一次');
  assert.equal(calls.filter((c) => c.includes('-keyboardClear')).length, 1);
  assert.equal(calls.filter((c) => c.includes(`-keyboard '中文'`)).length, 1);
  assert.equal(calls.filter((c) => c.includes(`-keyboard '第二次'`)).length, 1);
});

test('Yadb：设备上已存在则不再推送', async () => {
  let pushes = 0;
  const adb = new Adb({
    serial: 'test',
    exec: async (args) => {
      const joined = args.join(' ');
      if (joined.includes('ls ')) return { code: 0, stdout: '/data/local/tmp/yadb\n', stderr: '' };
      if (joined.includes('push ')) pushes++;
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  const yadb = new Yadb(adb, { localPath: 'VENDOR/yadb' });
  await yadb.type('x');
  assert.equal(pushes, 0);
  assert.equal(yadb.remote, YADB_REMOTE);
});

test('readTextAt：找包含点的最小节点做回读', () => {
  const outer = { bounds: [0, 0, 720, 1280], text: '', contentDesc: '' };
  const field = { bounds: [16, 1140, 704, 1220], text: '中文输入测试', contentDesc: '' };
  const far = { bounds: [0, 100, 100, 200], text: '别处', contentDesc: '' };
  assert.equal(readTextAt([outer, field, far], [360, 1180]), '中文输入测试');
  assert.equal(readTextAt([outer, field, far], [50, 150]), '别处');
  assert.equal(readTextAt([outer], [9999, 9999]), null);
  assert.deepEqual(findNodeAtPoint([field, outer], [360, 1180]), field, '取最小面积');
});

test('readTextAt：password 节点返回等长掩码串，不泄明文', () => {
  const field = { bounds: [16, 1140, 704, 1220], text: 'S3cret', password: true, contentDesc: '' };
  const plain = { bounds: [0, 100, 100, 200], text: '普通文本', contentDesc: '' };
  assert.equal(readTextAt([field, plain], [360, 1180]), '••••••', 'password 节点回读为与 text 等长的掩码');
  assert.equal(readTextAt([field, plain], [50, 150]), '普通文本', '非 password 节点行为不变');
  assert.equal(readTextAt([{ bounds: [0, 0, 10, 10], text: 'abc', password: true }], [900, 900]), null, '点外无节点仍返回 null');
});
