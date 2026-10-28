// uitree：真实样本解析（§16.3 允许 mock adb 输出=真实 dump 样本）、杂质截断、hash 稳定性
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  truncateAtHierarchyEnd,
  parseBounds,
  parseXmlDump,
  flattenNodes,
  treeHash,
  nodeIdentity,
} from '../src/device/uitree.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/ui-dump.xml', import.meta.url));
const EXPECTED = fileURLToPath(new URL('./fixtures/ui-dump.expected.json', import.meta.url));

const loadFixture = () => {
  const xml = readFileSync(FIXTURE, 'utf8');
  return { xml, nodes: parseXmlDump(truncateAtHierarchyEnd(xml)) };
};

test('杂质截断：/dev/tty 尾缀按 </hierarchy> 截断', () => {
  const noisy = '</hierarchy>\nUI hierchary dumped to: /dev/tty\n';
  assert.equal(truncateAtHierarchyEnd(noisy), '</hierarchy>');
  assert.equal(truncateAtHierarchyEnd('<hierarchy>\n<node/></hierarchy>'), '<hierarchy>\n<node/></hierarchy>');
  // 无 hierarchy 的错误输出原样返回
  assert.equal(truncateAtHierarchyEnd('ERROR: could not get idle state.'), 'ERROR: could not get idle state.');
});

test('parseBounds：[l,t][r,b] → 数组', () => {
  assert.deepEqual(parseBounds('[512,760][704,880]'), [512, 760, 704, 880]);
  assert.deepEqual(parseBounds('[0,0][720,1280]'), [0, 0, 720, 1280]);
  assert.equal(parseBounds('bad'), null);
  assert.equal(parseBounds(undefined), null);
});

test('真实样本解析：与手算期望逐字段一致（含中文 text、clickable=false、嵌套层级）', () => {
  const { xml, nodes } = loadFixture();
  const expected = JSON.parse(readFileSync(EXPECTED, 'utf8'));
  assert.ok(xml.includes('UI hierchary dumped to: /dev/tty'), '夹具必须带真实尾缀杂质');
  assert.equal(nodes.length, expected.roots);
  assert.deepEqual(nodes, expected.nodes);
});

test('flattenNodes：深度优先序', () => {
  const { nodes } = loadFixture();
  const expected = JSON.parse(readFileSync(EXPECTED, 'utf8'));
  const flat = flattenNodes(nodes);
  assert.equal(flat.length, expected.flatCount);
  assert.deepEqual(flat.map((n) => n.text), expected.flatTexts);
  assert.deepEqual(flat.map((n) => n.clickable), expected.flatClickables);
  // 首个是根，最后一个是最深叶子分支的末节点
  assert.equal(flat[0].cls, 'android.widget.FrameLayout');
  assert.equal(flat.at(-1).resourceId, 'com.lgdg:id/search_input');
});

test('hash 稳定：同输入同 hash；内容变化 hash 变；16 位 hex', () => {
  const { xml } = loadFixture();
  const h1 = treeHash(parseXmlDump(truncateAtHierarchyEnd(xml)));
  const h2 = treeHash(parseXmlDump(truncateAtHierarchyEnd(xml)));
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{16}$/);
  // 杂质不影响 hash
  assert.equal(treeHash(parseXmlDump(xml)), h1);
  // 文本变化 → hash 变
  const mutated = xml.replace('电子相册', '电子相簿');
  assert.notEqual(treeHash(parseXmlDump(truncateAtHierarchyEnd(mutated))), h1);
  // bounds 变化 → hash 变
  const moved = xml.replace('[32,180][300,230]', '[32,181][300,231]');
  assert.notEqual(treeHash(parseXmlDump(truncateAtHierarchyEnd(moved))), h1);
});

test('XML 实体解码与 parent 指针', () => {
  const nodes = parseXmlDump(
    '<hierarchy><node index="0" text="a&amp;b" class="X" clickable="false" bounds="[0,0][10,10]"><node index="0" text="子" class="Y" clickable="true" bounds="[0,0][5,5]"/></node></hierarchy>'
  );
  const flat = flattenNodes(nodes);
  assert.equal(flat[0].text, 'a&b');
  assert.equal(flat[1].text, '子');
  assert.equal(flat[1].parent, flat[0]); // 非枚举属性
  assert.equal(Object.keys(flat[1]).includes('parent'), false, 'parent 不得进枚举键（不污染深比较/序列化）');
  assert.deepEqual(nodeIdentity(flat[1]), { text: '子', contentDesc: '', resourceId: '', cls: 'Y', clickable: true });
});

test('自闭合与空树边界', () => {
  assert.deepEqual(parseXmlDump('<hierarchy><node index="0" text="s" class="A" bounds="[1,2][3,4]"/></hierarchy>'), [
    { index: 0, text: 's', cls: 'A', resourceId: '', contentDesc: '', clickable: false, enabled: true, bounds: [1, 2, 3, 4], center: [2, 3], children: [] },
  ]);
  assert.deepEqual(parseXmlDump(''), []);
});
