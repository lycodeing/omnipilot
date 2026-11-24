// useDump.js 测试（契约 §1 / §4.1）：读侧的解析、去重保最新、实体解码、坏 JSON 跳过
//
// 这是报告的读侧安全边界的一半——写侧转义做对还不够，读侧必须能正确还原。
// 用 jsdom 构造真实 HTML 文档（与浏览器解析行为一致）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { parseReportDocument } from '../src/composables/useDump.js'

// 构造一个含 ask-dump / ask-image 标签的文档
function makeDoc({ dumps = [], images = [] } = {}) {
  const dumpTags = dumps
    .map((d) => `<script type="ask-dump" data-group-id="${d.groupId ?? 'default'}">${d.json}</script>`)
    .join('\n')
  const imageTags = images
    .map((i) => `<script type="ask-image" data-id="${i.id}">${i.src}</script>`)
    .join('\n')
  const html = `<!doctype html><html><body>${dumpTags}\n${imageTags}\n<div id="root"></div></body></html>`
  return new JSDOM(html).window.document
}

test('parseReportDocument：解析 dump 的 executions 与 meta', () => {
  const doc = makeDoc({
    dumps: [{
      groupId: 'g1',
      json: JSON.stringify({
        sdkVersion: 'ask-0.1.0',
        groupName: '巡检',
        status: 'pass',
        durationMs: 1234,
        executions: [{ tasks: [{ taskId: '0', type: 'tap', status: 'finished' }] }],
      }),
    }],
  })
  const r = parseReportDocument(doc)
  assert.equal(r.meta.sdkVersion, 'ask-0.1.0')
  assert.equal(r.meta.groupName, '巡检')
  assert.equal(r.meta.status, 'pass')
  assert.equal(r.meta.durationMs, 1234)
  assert.equal(r.executions.length, 1)
  assert.equal(r.executions[0].tasks[0].type, 'tap')
})

test('parseReportDocument：同 group 去重保最新', () => {
  const doc = makeDoc({
    dumps: [
      { groupId: 'g1', json: JSON.stringify({ groupName: '旧', executions: [{ tasks: [] }] }) },
      { groupId: 'g1', json: JSON.stringify({ groupName: '新', executions: [{ tasks: [] }] }) },
    ],
  })
  const r = parseReportDocument(doc)
  assert.equal(r.meta.groupName, '新', '同 group 应保最新')
  assert.equal(r.executions.length, 1, '同 group 只应保留一份')
})

test('parseReportDocument：不同 group 各自保留', () => {
  const doc = makeDoc({
    dumps: [
      { groupId: 'g1', json: JSON.stringify({ groupName: 'A', executions: [{ tasks: [] }] }) },
      { groupId: 'g2', json: JSON.stringify({ groupName: 'B', executions: [{ tasks: [] }] }) },
    ],
  })
  const r = parseReportDocument(doc)
  assert.equal(r.executions.length, 2)
})

test('parseReportDocument：data-group-id 的 HTML 实体被正确解码', () => {
  // 写侧 attrEscape 会把 & 编码成 &amp; —— 读侧必须解码，否则 group id 不一致
  const json = JSON.stringify({ groupName: '巡检&回归', executions: [{ tasks: [] }] })
  const html = `<!doctype html><html><body><script type="ask-dump" data-group-id="a&amp;b">${json}</script></body></html>`
  const doc = new JSDOM(html).window.document
  const r = parseReportDocument(doc)
  assert.equal(r.executions.length, 1, '解码后应正常解析出该 dump')
  assert.equal(r.meta.groupName, '巡检&回归')
  // 浏览器 getAttribute 会解码实体——读侧拿到的 group id 应是解码后的 "a&b"
  const tag = doc.querySelector('script[type="ask-dump"]')
  assert.equal(tag.getAttribute('data-group-id'), 'a&b', '浏览器侧已解码')
})

test('parseReportDocument：坏 JSON 的 dump 被跳过，不影响其它 dump', () => {
  const doc = makeDoc({
    dumps: [
      { groupId: 'bad', json: '{不是合法 JSON' },
      { groupId: 'good', json: JSON.stringify({ groupName: '好的', executions: [{ tasks: [] }] }) },
    ],
  })
  const r = parseReportDocument(doc)
  assert.equal(r.meta.groupName, '好的', '坏 dump 不应影响好的')
  assert.equal(r.executions.length, 1)
})

test('parseReportDocument：ask-image 覆盖 single-html 占位', () => {
  const doc = makeDoc({
    dumps: [{
      groupId: 'g1',
      json: JSON.stringify({ executions: [], screenshots: { s1: '' } }),
    }],
    images: [{ id: 's1', src: 'data:image/png;base64,iVBORw0KGgo=' }],
  })
  const r = parseReportDocument(doc)
  assert.ok(r.screenshots.s1, 'ask-image 应覆盖空串占位')
  assert.ok(String(r.screenshots.s1).startsWith('data:') || String(r.screenshots.s1).startsWith('blob:'),
    'data URL 应被转成可显示的 URL')
})

test('parseReportDocument：assets 模式相对路径直通', () => {
  const doc = makeDoc({
    dumps: [{
      groupId: 'g1',
      json: JSON.stringify({ executions: [], screenshots: { s1: './screenshots/s1.png' } }),
    }],
  })
  const r = parseReportDocument(doc)
  assert.equal(r.screenshots.s1, './screenshots/s1.png')
})

test('parseReportDocument：透传 assertions / networkTimeline / rollbacks', () => {
  const doc = makeDoc({
    dumps: [{
      groupId: 'g1',
      json: JSON.stringify({
        executions: [],
        assertions: [{ text: '断言A', passed: true }],
        networkTimeline: [{ at: 100, profile: '3g' }],
        rollbacks: [{ stepIndex: 2, reason: 'x', recovered: true }],
      }),
    }],
  })
  const r = parseReportDocument(doc)
  assert.equal(r.assertions.length, 1)
  assert.equal(r.networkTimeline.length, 1)
  assert.equal(r.rollbacks.length, 1)
})

test('parseReportDocument：空文档返回空形状而非抛错', () => {
  const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document
  const r = parseReportDocument(doc)
  assert.deepEqual(r.executions, [])
  assert.deepEqual(r.screenshots, {})
  assert.equal(r.meta.sdkVersion, '')
})
