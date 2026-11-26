// 设备层 content://sms 解析纯函数测试（sms_read 的 device.readSms 底座）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSmsContent } from '../src/device/sms.js';

test('parseSmsContent：解析 content query 输出', () => {
  const out = 'Row: 0 address=10690000, body=【掘金】验证码 123456，5分钟内有效, date=1750000000000\nRow: 1 address=10086, body=余额提醒, date=1749999999999';
  const msgs = parseSmsContent(out);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].address, '10690000');
  assert.ok(msgs[0].body.includes('123456'));
});

test('parseSmsContent：空输出/错误输出 → 空数组', () => {
  assert.deepEqual(parseSmsContent(''), []);
  assert.deepEqual(parseSmsContent('SecurityException'), []);
});
