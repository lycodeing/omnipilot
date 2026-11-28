// transcript 落盘测试：写入器 meta 头 + JSONL 追加；createChatClient 成功/失败/重试各记一条，
// 图片只记摘要不落原图，写入器抛错不阻断请求。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTranscriptWriter } from '../src/recorder/transcript.js';
import { createChatClient } from '../src/tools/ai.js';

function tmpRunDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-transcript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readEntries(runDir) {
  return fs.readFileSync(path.join(runDir, 'transcript.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
}

describe('createTranscriptWriter', () => {
  test('创建目录并写 meta 头，条目逐行追加为合法 JSON', (t) => {
    const runDir = path.join(tmpRunDir(t), 'run-x'); // 目录不存在时自动创建
    const writer = createTranscriptWriter(runDir);
    writer({ model: 'm1', prompt: '第一条' });
    writer({ model: 'm1', prompt: '第二条' });
    const entries = readEntries(runDir);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].type, 'meta');
    assert.match(entries[0].note, /session\.prompt/);
    assert.equal(entries[1].prompt, '第一条');
    assert.equal(entries[2].prompt, '第二条');
  });
});

describe('createChatClient transcript 拦截', () => {
  const okFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: '{"ok":1}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  });

  test('成功请求：记录 prompt/system/response/usage/耗时，error 为 null', async (t) => {
    const runDir = tmpRunDir(t);
    const chat = createChatClient({
      url: 'https://mock.api/v1', key: 'k', model: 'm',
      fetchImpl: okFetch, transcriptWriter: createTranscriptWriter(runDir),
    });
    await chat('你好', { system: '自定义系统提示' });
    const entries = readEntries(runDir).filter((entry) => entry.type !== 'meta');
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.model, 'm');
    assert.equal(entry.prompt, '你好');
    assert.equal(entry.system, '自定义系统提示');
    assert.equal(entry.response, '{"ok":1}');
    assert.deepEqual(entry.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    assert.equal(entry.error, null);
    assert.equal(entry.attempt, 0);
    assert.ok(Number.isFinite(entry.durationMs) && entry.durationMs >= 0);
    assert.ok(entry.timestamp);
  });

  test('图片只记 mime 与估算字节数，不落 base64 原图（字符串与对象两种形态）', async (t) => {
    const runDir = tmpRunDir(t);
    const chat = createChatClient({
      url: 'https://mock.api/v1', key: 'k', model: 'm',
      fetchImpl: okFetch, transcriptWriter: createTranscriptWriter(runDir),
    });
    const base64Data = 'A'.repeat(400); // 400 字符 base64 ≈ 300 字节
    await chat('定位', { images: [base64Data, { data: base64Data, mimeType: 'image/jpeg' }] });
    const entry = readEntries(runDir).find((item) => item.type !== 'meta');
    assert.deepEqual(entry.images, [
      { mimeType: 'image/png', sizeBytes: 300 },
      { mimeType: 'image/jpeg', sizeBytes: 300 },
    ]);
    assert.equal(JSON.stringify(entry).includes(base64Data), false);
  });

  test('失败重试：每次尝试各记一条 error，attempt 递增，最终仍抛错', async (t) => {
    const runDir = tmpRunDir(t);
    let callCount = 0;
    const chat = createChatClient({
      url: 'https://mock.api/v1', key: 'k', model: 'm',
      fetchImpl: async () => { callCount++; throw new Error('网关不可达'); },
      transcriptWriter: createTranscriptWriter(runDir),
    });
    await assert.rejects(() => chat('ping', { maxRetries: 1 }), /网关不可达/);
    assert.equal(callCount, 2);
    const entries = readEntries(runDir).filter((entry) => entry.type !== 'meta');
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((entry) => entry.attempt), [0, 1]);
    assert.ok(entries.every((entry) => entry.error === '网关不可达' && entry.response === null && entry.usage === null));
  });

  test('HTTP 非 2xx：error 含状态码；空内容也记失败', async (t) => {
    const runDir = tmpRunDir(t);
    const chat = createChatClient({
      url: 'https://mock.api/v1', key: 'k', model: 'm',
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => '内部错误' }),
      transcriptWriter: createTranscriptWriter(runDir),
    });
    await assert.rejects(() => chat('ping', { maxRetries: 0 }), /HTTP 500/);
    const entry = readEntries(runDir).find((item) => item.type !== 'meta');
    assert.match(entry.error, /HTTP 500/);
  });

  test('transcriptWriter 抛错不阻断请求；未传 writer 行为不变', async () => {
    const throwingWriter = () => { throw new Error('磁盘满'); };
    const chat = createChatClient({
      url: 'https://mock.api/v1', key: 'k', model: 'm',
      fetchImpl: okFetch, transcriptWriter: throwingWriter,
    });
    assert.equal(await chat('hi'), '{"ok":1}');
    const plainChat = createChatClient({ url: 'https://mock.api/v1', key: 'k', model: 'm', fetchImpl: okFetch });
    assert.equal(await plainChat('hi'), '{"ok":1}');
  });
});