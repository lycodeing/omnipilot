// 会话历史截图治理（§16）单测：旧图替换为占位符、最近 N 张保留
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneImages, replaceImagesWithPlaceholder, countImages, PLACEHOLDER_PREFIX , pruneToolResults, TOOLRESULT_PLACEHOLDER } from '../src/session/image-prune.js';

const img = (kb = 100) => ({ type: 'image', mimeType: 'image/png', data: 'A'.repeat(Math.round(kb * 1024 * 4 / 3)) });

test('countImages：统计 content 里的 image block', () => {
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'toolResult', content: [img(), { type: 'text', text: 'meta' }] },
    { role: 'toolResult', content: [img(), img()] },
  ];
  assert.equal(countImages(msgs), 3);
  assert.equal(countImages([]), 0);
  assert.equal(countImages(null), 0);
});

test('replaceImagesWithPlaceholder：单个消息内 image → 文字占位符', () => {
  const msg = { role: 'toolResult', content: [img(200), { type: 'text', text: 'meta' }] };
  const r = replaceImagesWithPlaceholder(msg);
  assert.equal(r.changed, true);
  assert.equal(r.count, 1);
  assert.equal(r.content[0].type, 'text');
  assert.ok(r.content[0].text.startsWith(PLACEHOLDER_PREFIX));
  assert.ok(r.content[0].text.includes('~200KB'), '占位符含原图大小');
  assert.equal(r.content[1].type, 'text', '非图片块保留');
});

test('replaceImagesWithPlaceholder：无图不改动', () => {
  const msg = { role: 'user', content: [{ type: 'text', text: 'x' }] };
  assert.equal(replaceImagesWithPlaceholder(msg).changed, false);
  assert.equal(replaceImagesWithPlaceholder({ role: 'user' }).changed, false);
  assert.equal(replaceImagesWithPlaceholder(null).changed, false);
});

test('pruneImages：保留最近 3 张，更早的替换', () => {
  const msgs = [];
  for (let i = 0; i < 5; i++) msgs.push({ role: 'toolResult', content: [img(), { type: 'text', text: 's' + i }] });
  const r = pruneImages(msgs, { keepRecent: 3 });
  assert.equal(r.total, 5);
  assert.equal(r.replaced, 2, '前 2 张被替换');
  assert.equal(r.kept, 3);
  // 前两条的 image 应变成 text
  assert.equal(msgs[0].content[0].type, 'text');
  assert.equal(msgs[1].content[0].type, 'text');
  // 后三条仍是 image（原样）
  assert.equal(msgs[2].content[0].type, 'image');
  assert.equal(msgs[3].content[0].type, 'image');
  assert.equal(msgs[4].content[0].type, 'image');
});

test('pruneImages：图片数不超阈值 → 不改动', () => {
  const msgs = [{ role: 'toolResult', content: [img(), img()] }];
  const r = pruneImages(msgs, { keepRecent: 3 });
  assert.equal(r.changed, false);
  assert.equal(r.replaced, 0);
  assert.equal(msgs[0].content[0].type, 'image');
});

test('pruneImages：同一消息内多图，从后往前保留最近 N 张', () => {
  const msgs = [{ role: 'toolResult', content: [img(1), img(2), img(3), img(4), img(5)] }];
  const r = pruneImages(msgs, { keepRecent: 2 });
  assert.equal(r.replaced, 3);
  assert.equal(msgs[0].content[0].type, 'text', '第1张替换');
  assert.equal(msgs[0].content[1].type, 'text', '第2张替换');
  assert.equal(msgs[0].content[2].type, 'text', '第3张替换');
  assert.equal(msgs[0].content[3].type, 'image', '第4张保留');
  assert.equal(msgs[0].content[4].type, 'image', '第5张保留');
});

test('pruneImages：跨多条消息混合，保留全局最近 N 张', () => {
  const msgs = [
    { role: 'toolResult', content: [img()] },              // 图1
    { role: 'user', content: [{ type: 'text', text: 'x' }] },
    { role: 'toolResult', content: [img(), img()] },       // 图2,3
    { role: 'toolResult', content: [img()] },              // 图4
  ];
  const r = pruneImages(msgs, { keepRecent: 2 });
  assert.equal(r.total, 4);
  assert.equal(r.replaced, 2, '替换图1、图2');
  assert.equal(msgs[0].content[0].type, 'text', '图1 替换');
  assert.equal(msgs[2].content[0].type, 'text', '图2 替换（消息内第1张）');
  assert.equal(msgs[2].content[1].type, 'image', '图3 保留');
  assert.equal(msgs[3].content[0].type, 'image', '图4 保留');
});

test('pruneImages：占位符可读（含尺寸与省略说明）', () => {
  const msgs = [{ role: 'toolResult', content: [img(340), img(340)] }];
  pruneImages(msgs, { keepRecent: 1 });
  const t = msgs[0].content[0].text;
  assert.ok(t.includes('截图已省略'), t);
  assert.ok(t.includes('340KB'), t);
  assert.ok(t.includes('image/png'), t);
});

test('pruneImages：token 收益——替换后 content 明显变小', () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ role: 'toolResult', content: [img(300)] });
  const before = JSON.stringify(msgs).length;
  pruneImages(msgs, { keepRecent: 2 });
  const after = JSON.stringify(msgs).length;
  assert.ok(after < before * 0.5, `替换后应显著变小（${after} vs ${before}）`);
});

test('pruneToolResults：保留最近 N 条完整，更早截断为摘要', () => {
  const big = 'x'.repeat(5000);
  const msgs = [
    { role: 'toolResult', content: [{ type: 'text', text: big }] },
    { role: 'toolResult', content: [{ type: 'text', text: big }] },
    { role: 'toolResult', content: [{ type: 'text', text: 'short' }] },
  ];
  const r = pruneToolResults(msgs, { keepRecent: 1, keepChars: 100 });
  assert.equal(r.replaced, 2, 'keepRecent=1 保留最新一条，其余两条大结果被截断');
  assert.ok(msgs[0].content[0].text.startsWith(TOOLRESULT_PLACEHOLDER));
  assert.ok(msgs[1].content[0].text.startsWith(TOOLRESULT_PLACEHOLDER));
  assert.ok(msgs[0].content[0].text.length < 500);
  assert.equal(msgs[2].content[0].text, 'short', '最近一条保持完整');
});

test('pruneToolResults：字符串 content 形态同样截断且幂等', () => {
  const big = 'y'.repeat(2000);
  const msgs = [{ role: 'toolResult', content: big }, { role: 'toolResult', content: big }];
  pruneToolResults(msgs, { keepRecent: 1, keepChars: 50 });
  const before = msgs[0].content;
  pruneToolResults(msgs, { keepRecent: 1, keepChars: 50 });
  assert.equal(msgs[0].content, before, '已截断的不再二次截断');
});
