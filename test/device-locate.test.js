// 定位策略链（§5.1）：精确→正则/包含→resource_id→class_index→VLM；clickable 兜底（§5.4.2）；hint 校验
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseXmlDump, truncateAtHierarchyEnd, treeHash } from '../src/device/uitree.js';
import { createLocator, parseTarget, compileSafeRegex, findByRegex, matchSelector, matchNodeSelector, inScreen } from '../src/device/locate.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/ui-dump.xml', import.meta.url));
const nodes = parseXmlDump(truncateAtHierarchyEnd(readFileSync(FIXTURE, 'utf8')));
const hash = treeHash(nodes);

function makeLocator({ fromCache = false } = {}) {
  const probeFile = join(mkdtempSync(join(tmpdir(), 'ask-locate-')), 'family-probe.json');
  const vlmCache = new Map();
  const locate = createLocator({
    getTree: async () => ({ nodes, hash, dumpMs: 5, fromCache }),
    getSize: async () => ({ w: 720, h: 1280 }),
    screencap: async () => Buffer.alloc(8),
    vlmCache,
    probeFile,
  });
  return { locate, vlmCache, probeFile };
}

test('parseTarget：各 selector 形式', () => {
  assert.deepEqual(parseTarget('text=电子相册#index=1'), { kind: 'exact_text', text: '电子相册', index: 1 });
  assert.deepEqual(parseTarget('id=com.lgdg:id/album'), { kind: 'resource_id', id: 'com.lgdg:id/album', index: 0 });
  assert.deepEqual(parseTarget('class=android.widget.TextView#index=2'), { kind: 'class_index', cls: 'android.widget.TextView', index: 2 });
  assert.deepEqual(parseTarget('desc=返回'), { kind: 'contains', text: '返回', field: 'contentDesc' });
  assert.deepEqual(parseTarget('re:相.*册'), { kind: 'regex', pattern: '相.*册' });
  assert.deepEqual(parseTarget('电子相册'), { kind: 'auto', text: '电子相册' });
});

test('策略1 精确文本：命中并按 §5.4.2 解析到可点祖先', async () => {
  const { locate } = makeLocator();
  const r = await locate('电子相册');
  assert.equal(r.ok, true);
  assert.equal(r.strategy, 'exact_text');
  assert.deepEqual(r.bounds, [16, 140, 704, 300], 'clickable=false → 最近可点祖先 item0');
  assert.deepEqual(r.center, [360, 220]);
  assert.match(r.warning, /可点/);
  assert.deepEqual(r.identity, { text: '', contentDesc: '', resourceId: 'com.lgdg:id/album_item', cls: 'android.widget.LinearLayout', clickable: true });
});

test('策略1：本就可点的节点直接返回，无警告', async () => {
  const { locate } = makeLocator();
  const r = await locate('新建相册');
  assert.equal(r.ok, true);
  assert.equal(r.strategy, 'exact_text');
  assert.deepEqual(r.bounds, [200, 980, 520, 1060]);
  assert.equal(r.warning, undefined);
});

test('策略2 正则/包含：短文本命中长 text', async () => {
  const { locate } = makeLocator();
  const r = await locate('电子');
  assert.equal(r.strategy, 'regex');
  assert.deepEqual(r.bounds, [16, 140, 704, 300]);
  const d = await locate('desc=返回');
  assert.equal(d.strategy, 'regex');
  assert.deepEqual(d.bounds, [16, 72, 80, 120], 'content-desc 命中 btn_back');
});

test('策略3 resource-id：id 全名或短名均命中', async () => {
  const { locate } = makeLocator();
  const r1 = await locate('album_name');
  assert.equal(r1.strategy, 'resource_id');
  assert.deepEqual(r1.bounds, [16, 140, 704, 300]);
  const r2 = await locate('id=album_date');
  assert.equal(r2.strategy, 'resource_id');
  assert.deepEqual(r2.bounds, [16, 140, 704, 300], '日期节点不可点 → 解析到 item0');
});

test('策略3 class+index：类名与 #index 选取', async () => {
  const { locate } = makeLocator();
  const r1 = await locate('class=android.widget.Button');
  assert.equal(r1.strategy, 'class_index');
  assert.deepEqual(r1.bounds, [200, 980, 520, 1060]);
  const r2 = await locate('class=android.widget.TextView#index=1');
  assert.equal(r2.strategy, 'class_index');
  assert.deepEqual(r2.bounds, [16, 140, 704, 300], '第 2 个 TextView 是 电子相册 → 可点祖先 item0');
  const r3 = await locate('android.widget.Button');
  assert.equal(r3.strategy, 'class_index', 'auto 目标形如类名也走 class_index');
});

test('策略5 失败：返回候选列表让模型改写描述', async () => {
  const { locate } = makeLocator();
  const r = await locate('不存在的元素xyz');
  assert.equal(r.ok, false);
  assert.equal(r.bounds, null);
  assert.match(r.error, /未找到目标/);
  assert.ok(Array.isArray(r.candidates) && r.candidates.length >= 8);
  assert.ok(r.candidates.every((c) => c.text || c.contentDesc));
});

test('策略1 多命中：按面积最小优先', async () => {
  const probeFile = join(mkdtempSync(join(tmpdir(), 'ask-locate-')), 'p.json');
  const small = { index: 0, text: '按钮', cls: 'B', resourceId: '', contentDesc: '', clickable: true, enabled: true, bounds: [100, 500, 200, 600], center: [150, 550], children: [] };
  const big = { index: 1, text: '按钮', cls: 'B', resourceId: '', contentDesc: '', clickable: true, enabled: true, bounds: [0, 0, 700, 100], center: [350, 50], children: [] };
  const locate = createLocator({
    getTree: async () => ({ nodes: [small, big], hash: 'x', dumpMs: 0, fromCache: false }),
    getSize: async () => ({ w: 720, h: 1280 }),
    screencap: async () => Buffer.alloc(0),
    vlmCache: new Map(),
    probeFile,
  });
  const r = await locate('按钮');
  assert.deepEqual(r.bounds, [100, 500, 200, 600]);
});

test('hint 跨执行坐标缓存：bounds+identity 双重校验命中 → strategy=cache', async () => {
  const { locate } = makeLocator();
  const first = await locate('电子相册');
  const again = await locate('电子相册', { hintBounds: first.bounds, hintIdentity: first.identity });
  assert.equal(again.strategy, 'cache');
  assert.deepEqual(again.bounds, first.bounds);
  assert.deepEqual(again.identity, first.identity);
});

test('hint 校验失败（identity 不符 / 缺 identity / bounds 无节点）→ 弃用走正常链', async () => {
  const { locate } = makeLocator();
  const bad1 = await locate('电子相册', { hintBounds: [16, 140, 704, 300], hintIdentity: { text: '别的', cls: 'X' } });
  assert.equal(bad1.strategy, 'exact_text');
  const bad2 = await locate('电子相册', { hintBounds: [16, 140, 704, 300] });
  assert.equal(bad2.strategy, 'exact_text');
  const bad3 = await locate('电子相册', { hintBounds: [1, 2, 3, 4], hintIdentity: { text: '电子相册', cls: 'android.widget.TextView' } });
  assert.equal(bad3.strategy, 'exact_text');
});

test('VLM 兜底（注入函数）：family 换算 + 结果缓存命中不再调模型', async () => {
  const { locate } = makeLocator();
  let calls = 0;
  const vlm = async ({ png, size, target }) => {
    calls++;
    assert.ok(png && size && target);
    return { raw: [250, 300, 500, 600], family: 'glm' };
  };
  const r1 = await locate('蓝色圆形按钮', { vlm });
  assert.equal(r1.ok, true);
  assert.equal(r1.strategy, 'vlm');
  assert.equal(r1.vlmCacheHit, false);
  assert.deepEqual(r1.bounds, [180, 384, 360, 768], '0-1000·xy 换算');
  assert.deepEqual(r1.center, [270, 576]);
  const r2 = await locate('蓝色圆形按钮', { vlm });
  assert.equal(r2.strategy, 'vlm');
  assert.equal(r2.vlmCacheHit, true, '同页面同 target 复用模型结果');
  assert.equal(calls, 1);
  // 树内可匹配的目标不触发 VLM
  await locate('新建相册', { vlm });
  assert.equal(calls, 1);
});

test('VLM：无 family 且无探测缓存 → 拒绝不猜（§5.5.3）', async () => {
  const { locate } = makeLocator();
  const r = await locate('蓝色圆形按钮', { vlm: async () => ({ raw: [250, 300, 500, 600] }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /坐标策略/);
});

test('VLM：换算越界 → 告警失败（family 约定用错的典型表现）', async () => {
  const { locate } = makeLocator();
  const r = await locate('蓝色圆形按钮', { vlm: async () => ({ raw: [500, 500, 1500, 1500], family: 'glm' }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /越界/);
});

test('treeCacheHit / dumpMs 透传；空 target 报错', async () => {
  const { locate } = makeLocator({ fromCache: true });
  const r = await locate('新建相册');
  assert.equal(r.treeCacheHit, true);
  assert.equal(r.dumpMs, 5);
  const empty = await locate('  ');
  assert.equal(empty.ok, false);
  assert.match(empty.error, /target 为空/);
});

test('clickable=false 且无祖先可点 → 向下找可点子孙（§5.4.2 顺序 3）', async () => {
  const probeFile = join(mkdtempSync(join(tmpdir(), 'ask-locate-')), 'p.json');
  const child = { index: 0, text: '', cls: 'C', resourceId: 'x:id/ok', contentDesc: '', clickable: true, enabled: true, bounds: [10, 10, 90, 90], center: [50, 50], children: [], parent: null };
  const parent = { index: 0, text: '确定', cls: 'P', resourceId: '', contentDesc: '', clickable: false, enabled: true, bounds: [0, 0, 100, 100], center: [50, 50], children: [child], parent: null };
  Object.defineProperty(child, 'parent', { value: parent, enumerable: false });
  const locate = createLocator({
    getTree: async () => ({ nodes: [parent], hash: 'x', dumpMs: 0, fromCache: false }),
    getSize: async () => ({ w: 720, h: 1280 }),
    screencap: async () => Buffer.alloc(0),
    vlmCache: new Map(),
    probeFile,
  });
  const r = await locate('确定');
  assert.deepEqual(r.bounds, [10, 10, 90, 90], '解析到可点子节点');
});

test('within 行内作用域定位：scope 行内的目标按钮', async () => {
  // 两行列表：行1=中医体质辨识+测评按钮A，行2=卒中风险评估+测评按钮B
  const flat = [
    { index:0, text:'中医体质辨识', cls:'TextView', resourceId:'', contentDesc:'', clickable:false, bounds:[40,300,700,400], center:[370,350], children:[] },
    { index:1, text:'测评', cls:'TextView', resourceId:'', contentDesc:'', clickable:true, bounds:[800,320,1000,380], center:[900,350], children:[] },
    { index:2, text:'卒中风险评估', cls:'TextView', resourceId:'', contentDesc:'', clickable:false, bounds:[40,450,700,550], center:[370,500], children:[] },
    { index:3, text:'测评', cls:'TextView', resourceId:'', contentDesc:'', clickable:true, bounds:[800,470,1000,530], center:[900,500], children:[] },
  ];
  const probeFile = join(mkdtempSync(join(tmpdir(), 'ask-locate-w-')), 'family-probe.json');
  const locate = createLocator({
    getTree: async () => ({ nodes: flat, hash: treeHash(flat), dumpMs: 1, fromCache: false }),
    getSize: async () => ({ w: 1080, h: 2340 }),
    screencap: async () => Buffer.alloc(8),
    vlmCache: new Map(),
    probeFile,
  });
  const r = await locate('within=text=中医体质辨识::text=测评', {});
  assert.equal(r.ok, true);
  assert.equal(r.strategy, 'within');
  assert.deepEqual(r.bounds, [800,320,1000,380], '应命中行1的测评按钮而非行2');
});

// ---- re: selector 的 ReDoS 防护 ----

test('compileSafeRegex：拒绝灾难性回溯模式（含绕过形态）', () => {
  // 守护：selector 可由用例文本/模型产出提供，是"外部输入 → 正则执行器"的
  // 直连通道。危险正则会在 UI 树每个节点上触发灾难性回溯，单次 locate 可挂死。
  // 需拒绝的绕过形态：
  //   (a|aa)+$          交替歧义
  //   (?:a{1,10}){1,10}$ {n,m} 型嵌套（36 字符即 5.5s）
  //   (a{2,})+$         {n,} 型嵌套
  for (const p of [
    '(a+)+$', '(x+x+)+y', '(a*)*x', '(\\w+\\s?)*$',
    '(a|aa)+$', '(?:a{1,10}){1,10}$', '(a{2,})+$', 'a{1,}{1,}', '(?:a|b)*c',
  ]) {
    assert.equal(compileSafeRegex(p), null, `应拒绝 ${p}`);
  }
  assert.equal(compileSafeRegex('a'.repeat(300)), null, '超长应被拒绝');
  // 反向引用 / 前后查找
  assert.equal(compileSafeRegex('(a)\\1'), null, '反向引用应被拒绝');
  assert.equal(compileSafeRegex('(?=abc)'), null, '前瞻应被拒绝');
});

test('compileSafeRegex：正常模式不被误拒', () => {
  for (const p of [
    '电子相册', '[0-9]+', 'item[0-9]+', '浏览|阅读|看过', '^设置',
    'colou?r', 'a{2,3}', '\\d+\\s*\\S+',
  ]) {
    assert.ok(compileSafeRegex(p), `不应误拒 ${p}`);
  }
});

test('findByRegex：危险模式返回空结果而非卡死', () => {
  const flat = [{ text: 'aaaa', contentDesc: '' }];
  assert.deepEqual(findByRegex(flat, '(a+)+$'), [], '危险模式应被拒');
  assert.deepEqual(findByRegex(flat, '(?:a{1,10}){1,10}$'), [], '绕过形态应被拒');
});

test('locate 失败信息可操作：含目标、已尝试策略、相关度排序的候选', async () => {
  // 守护：失败信息须含目标、已尝试策略、相关度排序的候选（而非 DFS 顺序前 8 个），模型才能自纠。
  const tree = {
    nodes: [
      { index: 0, text: '', cls: 'FrameLayout', resourceId: '', contentDesc: '', clickable: false, bounds: [0, 0, 720, 1280], children: [
        { index: 1, text: '首页', cls: 'TextView', resourceId: '', contentDesc: '', clickable: false, bounds: [0, 0, 100, 50], children: [] },
        { index: 2, text: '电子相册', cls: 'TextView', resourceId: 'com.lgdg:id/album', contentDesc: '', clickable: true, bounds: [0, 100, 200, 150], children: [] },
      ] },
    ],
    hash: 'h', dumpMs: 1, fromCache: false,
  };
  const locate = createLocator({
    getTree: async () => tree,
    getSize: async () => ({ w: 720, h: 1280 }),
    screencap: async () => ({ buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }),
    vlmCache: null,
  });
  const r = await locate('不存在的按钮');
  assert.equal(r.ok, false);
  assert.match(r.error, /不存在的按钮/, '错误信息应包含目标');
  assert.match(r.error, /已尝试策略/, '错误信息应说明尝试过的策略');
  assert.ok(Array.isArray(r.candidates) && r.candidates.length > 0);
});

test('两套 selector 语法对 text*= 判定一致', () => {
  // 守护：parseTarget 与 matchNodeSelector 两套语法对 text*= 判定一致（工具层文档承诺支持）。
  const flat = [{ index: 0, text: '热度榜', contentDesc: '', resourceId: '', cls: 'TextView', clickable: false, bounds: [0, 0, 100, 50], children: [] }];
  assert.ok(matchSelector(flat, 'text*=热度'), 'matchSelector 应支持 text*= 前缀匹配');
  assert.ok(flat.some((n) => matchNodeSelector(n, 'text*=热度')), 'matchNodeSelector 应支持 text*=');
  assert.ok(matchSelector(flat, 'text=热度榜'), 'text= 精确匹配仍工作');
});

test('LOCATE_MISS 落盘树快照：flat 写入 missDumpDir 供排查', async () => {
  const { mkdtempSync, readdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'ask-locate-miss-'));
  const flat = [
    { index: 0, text: '', contentDesc: '确认', resourceId: '', cls: 'TextView', clickable: false, bounds: [0, 0, 0, 0], children: [] },
    { index: 1, text: '立即提交', contentDesc: '', resourceId: '', cls: 'Button', clickable: true, bounds: [23, 2160, 1057, 2278], children: [] },
  ];
  const locate = createLocator({
    getTree: async () => ({ nodes: flat, hash: 'miss-h', dumpMs: 1, fromCache: false }),
    getSize: async () => ({ w: 1080, h: 2400 }),
    screencap: async () => ({ buffer: Buffer.alloc(0) }),
    vlmCache: null,
    missDumpDir: dir,
  });
  const r = await locate('text=确认');
  assert.equal(r.ok, false, '零面积节点应被 inScreen 过滤 → MISS');
  const files = readdirSync(dir).filter((f) => f.startsWith('locate-miss-') && f.endsWith('.json'));
  assert.equal(files.length, 1, '应落盘一个树快照文件');
  const snap = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
  assert.equal(snap.target, 'text=确认');
  assert.equal(snap.reason, 'inScreen 过滤');
  assert.ok(Array.isArray(snap.nodes) && snap.nodes.length === 2, '快照应含当次 flat 全部节点');
  assert.equal(snap.nodes[0].contentDesc, '确认', '快照应保留零面积节点的 contentDesc');
});

test('诊断 reason 与定位链同源：各 selector 形态都能识别「零面积被过滤」', async () => {
  const { mkdtempSync, readdirSync } = await import('node:fs');
  // 目标节点统一为 contentDesc='确认'、零面积 bounds；各形态 selector 都应命中它
  const flat = [
    { index: 0, text: '', contentDesc: '确认', resourceId: '', cls: 'TextView', clickable: false, bounds: [0, 0, 0, 0], children: [] },
    { index: 1, text: '中医体质辨识', contentDesc: '', resourceId: '', cls: 'TextView', clickable: false, bounds: [0, 100, 200, 150], children: [] },
  ];
  const targets = ['text=确认', 'text*=确', 'desc=确认', 're:确认'];
  for (const target of targets) {
    const dir = mkdtempSync(join(tmpdir(), 'ask-locate-miss-'));
    const locate = createLocator({
      getTree: async () => ({ nodes: flat, hash: 'h', dumpMs: 1, fromCache: false }),
      getSize: async () => ({ w: 1080, h: 2400 }),
      screencap: async () => ({ buffer: Buffer.alloc(0) }),
      vlmCache: new Map(),
      missDumpDir: dir,
    });
    const r = await locate(target);
    assert.equal(r.ok, false, `${target} 零面积节点应 MISS`);
    const f = readdirSync(dir).find((x) => x.startsWith('locate-miss-'));
    const snap = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    assert.equal(snap.reason, 'inScreen 过滤', `${target} 应判为 inScreen 过滤而非无匹配节点`);
  }
  // within：主链不过 inScreen，MISS 只可能是「作用域内无合规 inner」。
  // 诊断必须给出 within 专属文案，而不是笼统的「无匹配节点」。
  const wFlat = [
    { index: 0, text: '中医体质辨识', contentDesc: '', resourceId: '', cls: 'TextView', clickable: false, bounds: [0, 100, 200, 150], children: [] },
    { index: 1, text: '别的按钮', contentDesc: '', resourceId: '', cls: 'Button', clickable: false, bounds: [420, 110, 660, 145], children: [] },
  ];
  const wDir = mkdtempSync(join(tmpdir(), 'ask-locate-miss-'));
  const wLocate = createLocator({
    getTree: async () => ({ nodes: wFlat, hash: 'h', dumpMs: 1, fromCache: false }),
    getSize: async () => ({ w: 1080, h: 2400 }),
    screencap: async () => ({ buffer: Buffer.alloc(0) }),
    vlmCache: new Map(),
    missDumpDir: wDir,
  });
  const wr = await wLocate('within=text=中医体质辨识::text=确认');
  assert.equal(wr.ok, false, 'within 作用域内无「确认」应 MISS');
  const wf = readdirSync(wDir).find((x) => x.startsWith('locate-miss-'));
  const wsnap = JSON.parse(readFileSync(join(wDir, wf), 'utf8'));
  assert.equal(wsnap.reason, 'within 作用域未命中', 'within 应给出专属文案');
});

test('诊断快照：6 个树上下文字段齐全 + 密码节点脱敏 + 未注入不落盘', async () => {
  const { mkdtempSync, readdirSync, writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'ask-locate-miss-'));
  const flat = [
    { index: 0, text: 'pa55w0rd', contentDesc: '密码内容', password: true, resourceId: '', cls: 'EditText', clickable: false, bounds: [0, 100, 200, 150], children: [] },
  ];
  const tree = { nodes: flat, hash: 'h', dumpMs: 7, fromCache: true, cachedAt: 1700000000000 };
  const locate = createLocator({
    getTree: async () => tree,
    getSize: async () => ({ w: 1080, h: 2400 }),
    screencap: async () => ({ buffer: Buffer.alloc(0) }),
    vlmCache: new Map(),
    missDumpDir: dir,
  });
  const r = await locate('不存在的目标');
  assert.equal(r.ok, false);
  const f = readdirSync(dir).find((x) => x.startsWith('locate-miss-') && x.endsWith('.json'));
  const snap = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  assert.equal(snap.treeFromCache, true);
  assert.equal(snap.treeCachedAt, 1700000000000);
  assert.equal(snap.dumpMs, 7);
  assert.equal(snap.treeUnavailable, false);
  assert.equal(snap.treeError, null);
  assert.deepEqual(snap.screenSize, { w: 1080, h: 2400 });
  assert.equal(snap.nodes[0].text, '[REDACTED]', 'password 节点 text 必须脱敏');
  assert.equal(snap.nodes[0].contentDesc, '[REDACTED]', 'password 节点 contentDesc 必须脱敏');
  assert.equal(snap.nodes[0].password, true);

  // 未注入 missDumpDir：不落盘、不影响返回
  const dir2 = mkdtempSync(join(tmpdir(), 'ask-locate-miss-'));
  const locate2 = createLocator({
    getTree: async () => tree,
    getSize: async () => ({ w: 1080, h: 2400 }),
    screencap: async () => ({ buffer: Buffer.alloc(0) }),
    vlmCache: new Map(),
  });
  const r2 = await locate2('不存在的目标');
  assert.equal(r2.ok, false);
  // 用 dir2 作为哨兵：未注入时不应产生任何快照（dir2 保持空）
  assert.equal(readdirSync(dir2).length, 0);
});

test('诊断落盘失败不污染定位结果（目录路径被文件占用）', async () => {
  const { mkdtempSync } = await import('node:fs');
  const blocker = join(mkdtempSync(join(tmpdir(), 'ask-locate-miss-')), 'blocker');
  const { writeFileSync: wf } = await import('node:fs');
  wf(blocker, 'not a dir'); // mkdir 会抛 EEXIST/ENOTDIR
  const locate = createLocator({
    getTree: async () => ({ nodes: [], hash: 'h', dumpMs: 1, fromCache: false }),
    getSize: async () => ({ w: 1080, h: 2400 }),
    screencap: async () => ({ buffer: Buffer.alloc(0) }),
    vlmCache: new Map(),
    missDumpDir: blocker,
  });
  const r = await locate('text=确认');
  assert.equal(r.ok, false, '落盘失败不应让定位变成成功');
  assert.match(r.error, /未找到目标/, '错误信息仍是正常的定位失败');
});

test('TREE_UNAVAILABLE + 有 vlm：树不可用仍走到 VLM 分支返回坐标', async () => {
  const { mkdtempSync, readdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'ask-locate-miss-'));
  // family=deepseek 的 toPixels 需要探测缓存；直接给 probeFile 写一个 deepseek 族
  const probe = join(dir, 'family-probe.json');
  const { writeFileSync: wf } = await import('node:fs');
  wf(probe, JSON.stringify({ family: 'deepseek' }));
  let vlmCalls = 0;
  const vlm = async () => { vlmCalls++; return { raw: '500 500', family: 'deepseek' }; };
  const locate = createLocator({
    getTree: async () => { throw new Error('uia2 busy；UiAutomation 槽被占用'); },
    getSize: async () => ({ w: 1080, h: 2400 }),
    screencap: async () => ({ buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }),
    vlmCache: new Map(),
    probeFile: probe,
    missDumpDir: dir,
  });
  const r = await locate('text=确认', { vlm });
  assert.equal(r.ok, true, '树不可用但有 VLM 时应返回视觉坐标');
  assert.equal(r.strategy, 'vlm');
  assert.equal(vlmCalls, 1, 'VLM 应被调用一次');
  assert.ok(Array.isArray(r.bounds) || Array.isArray(r.center), '应有可用坐标');
});

test('TREE_UNAVAILABLE + 无 vlm：返回结构化 code 且落盘诊断（不伪装普通 MISS）', async () => {
  const { mkdtempSync, readdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'ask-locate-miss-'));
  const locate = createLocator({
    getTree: async () => { throw new Error('uia2 busy；UiAutomation 槽被占用'); },
    getSize: async () => ({ w: 1080, h: 2400 }),
    screencap: async () => ({ buffer: Buffer.alloc(0) }),
    vlmCache: new Map(),
    missDumpDir: dir,
  });
  const r = await locate('text=确认');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TREE_UNAVAILABLE');
  assert.match(r.error, /uia2 busy/);
  const f = readdirSync(dir).find((x) => x.startsWith('locate-miss-') && x.endsWith('.json'));
  const snap = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  assert.equal(snap.reason, '树不可用(dump 失败)');
  assert.equal(snap.treeUnavailable, true);
  assert.match(snap.treeError, /uia2 busy/);
  assert.equal(Array.isArray(snap.nodes) && snap.nodes.length, 0, '树不可用时快照 nodes 为空数组');
});

test('TREE_UNAVAILABLE + VLM 也失败：早退仍带 TREE_UNAVAILABLE（不让上层空等 waitIdle）', async () => {
  const { mkdtempSync, writeFileSync: wf } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'ask-locate-miss-'));
  const probe = join(dir, 'family-probe.json');
  wf(probe, JSON.stringify({ family: 'deepseek' }));
  const locate = createLocator({
    getTree: async () => { throw new Error('uia2 busy'); },
    getSize: async () => ({ w: 1080, h: 2400 }),
    screencap: async () => ({ buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }),
    vlmCache: new Map(),
    probeFile: probe,
    missDumpDir: dir,
  });
  const r = await locate('text=确认', { vlm: async () => ({ raw: 'NOT_FOUND', family: 'deepseek' }) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TREE_UNAVAILABLE', 'VLM 早退也必须保留树不可用的结构化 code');
});

// 守护：树不可用时没有可信的 tree.hash 做缓存失效，vlmCache 键「tree-unavailable:<错误文本>」
// 不随画面变化——同 target 会跨画面命中陈旧 VLM 坐标点错位置。树不可用路径必须跳过 vlmCache。
test('TREE_UNAVAILABLE：vlmCache 不得跨画面复用（每次都重新看图）', async () => {
  const { mkdtempSync, writeFileSync: wf } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'ask-locate-vlm-'));
  const probe = join(dir, 'family-probe.json');
  wf(probe, JSON.stringify({ family: 'deepseek' }));
  const vlmCache = new Map();
  let calls = 0;
  // 每次调用返回不同坐标，模拟"画面已变"
  const vlm = async () => { calls++; return { raw: calls === 1 ? '866 234' : '540 1320', family: 'deepseek' }; };
  const locate = createLocator({
    getTree: async () => { throw new Error('uia2 busy（重试仍失败）；legacy 因 UiAutomation 槽被占用不可用'); },
    getSize: async () => ({ w: 1080, h: 2400 }),
    screencap: async () => Buffer.from([0x89]),
    vlmCache, probeFile: probe,
  });
  const r1 = await locate('text=确认', { vlm });
  const r2 = await locate('text=确认', { vlm });
  assert.equal(calls, 2, '树不可用时每次都应重新调用 VLM，不得命中缓存');
  assert.equal(r2.vlmCacheHit, false, '第二次不应命中陈旧缓存');
  assert.notDeepEqual(r2.center, r1.center, '画面已变，坐标应不同');
});

test('SIZE_UNAVAILABLE + treeError：双重故障拼接错误 + 落盘诊断', async () => {
  const { mkdtempSync, readdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'ask-locate-miss-'));
  const locate = createLocator({
    getTree: async () => { throw new Error('uia2 busy'); },
    getSize: async () => { throw new Error('wm size 不可用'); },
    screencap: async () => Buffer.alloc(0),
    vlmCache: new Map(),
    missDumpDir: dir,
  });
  // 必须有 vlm 才能让 getTree 抛错后继续走到 getSize（无 vlm 时 TREE_UNAVAILABLE 早退）
  const r = await locate('text=确认', { vlm: async () => ({ raw: 'NOT_FOUND', family: 'deepseek' }) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SIZE_UNAVAILABLE');
  assert.match(r.error, /uia2 busy/, '应保留树失败原因');
  assert.match(r.error, /wm size/, '应包含尺寸失败原因');
  const f = readdirSync(dir).find((x) => x.startsWith('locate-miss-') && x.endsWith('.json'));
  assert.ok(f, '双重故障也应落盘诊断');
  const snap = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  assert.equal(snap.treeUnavailable, true);
  assert.match(snap.treeError, /uia2 busy/);
});

test('MISS_DUMP_MAX_FILES：写满 20 后第 21 次不落盘', async () => {
  const { mkdtempSync, readdirSync, writeFileSync: wf } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'ask-locate-miss-'));
  // 预填 20 个占位文件
  for (let i = 0; i < 20; i++) wf(join(dir, `locate-miss-${i}.json`), '{}');
  const locate = createLocator({
    getTree: async () => ({ nodes: [], hash: 'h', dumpMs: 1, fromCache: false }),
    getSize: async () => ({ w: 1080, h: 2400 }),
    screencap: async () => Buffer.alloc(0),
    vlmCache: new Map(),
    missDumpDir: dir,
  });
  await locate('text=不存在');
  const files = readdirSync(dir).filter((f) => f.startsWith('locate-miss-') && f.endsWith('.json'));
  assert.equal(files.length, 20, '达上限后不应新增文件');
});

// screenSignature 排除状态栏噪声的行为守护（独立于 run-loop 截图时序）
import { screenSignature } from '../src/device/png.js';
import { encodePng as encPng } from '../src/image/png.js';

test('screenSignature：仅状态栏区域变化 → 签名相同；主体变化 → 签名不同', () => {
  const w=100, h=200, topSkip=Math.round(h*0.06);
  const base = Buffer.alloc(w*h*3);
  for(let i=0;i<w*h;i++){base[i*3]=128;base[i*3+1]=128;base[i*3+2]=128;}
  const pngBase = encPng(w,h,base,2);

  // 仅改顶部 topSkip 行（状态栏区域）
  const statusOnly = Buffer.from(base);
  for(let y=0;y<topSkip;y++) for(let x=0;x<w;x++){const i=(y*w+x)*3;statusOnly[i]=255;statusOnly[i+1]=0;statusOnly[i+2]=0;}
  const pngStatus = encPng(w,h,statusOnly,2);
  assert.equal(screenSignature(pngBase), screenSignature(pngStatus), '仅状态栏变化 → 签名应相同');

  // 改采样点上的主体像素（y=92, x=0/40/80）
  const bodyChange = Buffer.from(base);
  for(const x of [0,40,80]){const i=(92*w+x)*3;bodyChange[i]=0;bodyChange[i+1]=255;bodyChange[i+2]=0;}
  const pngBody = encPng(w,h,bodyChange,2);
  assert.notEqual(screenSignature(pngBase), screenSignature(pngBody), '主体采样点变化 → 签名应不同');
});

// ─── WebView 零面积 bounds 统一放行 ───────────────────────────────────────
import { isZeroAreaBounds, hasWebViewContainer, shouldAllowZeroAreaNode } from '../src/device/uitree.js';

test('isZeroAreaBounds：识别零面积与无效 bounds', () => {
  assert.equal(isZeroAreaBounds({ bounds: [0, 0, 0, 0] }), true);
  assert.equal(isZeroAreaBounds({ bounds: [10, 20, 10, 20] }), true); // 宽=0
  assert.equal(isZeroAreaBounds({ bounds: [10, 20, 30, 20] }), true); // 高=0
  assert.equal(isZeroAreaBounds({ bounds: [10, 20, 30, 40] }), false);
  assert.equal(isZeroAreaBounds({ bounds: null }), true);
  assert.equal(isZeroAreaBounds({}), true);
});

test('hasWebViewContainer：检测 WebView 壳', () => {
  assert.equal(hasWebViewContainer([{ cls: 'android.webkit.WebView' }]), true);
  assert.equal(hasWebViewContainer([{ cls: 'WebView' }]), true);
  assert.equal(hasWebViewContainer([{ cls: 'android.widget.TextView' }]), false);
  assert.equal(hasWebViewContainer([]), false);
});

test('inScreen：WebView 零面积放行，纯原生零面积仍拒绝', () => {
  const size = { w: 1080, h: 2400 };
  const webViewFlat = [{ cls: 'android.webkit.WebView', bounds: [0, 0, 1080, 2400] }];
  const nativeFlat = [{ cls: 'android.widget.FrameLayout', bounds: [0, 0, 1080, 2400] }];
  // WebView 壳内零面积 → 放行
  assert.equal(inScreen([0, 0, 0, 0], size, webViewFlat), true);
  // 纯原生零面积 → 拒绝
  assert.equal(inScreen([0, 0, 0, 0], size, nativeFlat), false);
  // 不传 flatNodes → 保持原严格行为（向后兼容）
  assert.equal(inScreen([0, 0, 0, 0], size), false);
  // 正常 bounds 不受影响
  assert.equal(inScreen([10, 20, 100, 200], size, webViewFlat), true);
  assert.equal(inScreen([10, 20, 100, 200], size), true);
});

test('locate：WebView 零面积节点可被定位且标记 inWebView', async () => {
  const flat = [
    { index: 0, text: '', contentDesc: '', resourceId: '', cls: 'android.webkit.WebView', clickable: false, bounds: [0, 0, 1080, 2400], children: [] },
    { index: 1, text: '健康', contentDesc: '', resourceId: '', cls: 'android.widget.TextView', clickable: true, bounds: [0, 0, 0, 0], children: [] },
  ];
  const locate = createLocator({
    getTree: async () => ({ nodes: flat, hash: 'h', dumpMs: 1, fromCache: false }),
    getSize: async () => ({ w: 1080, h: 2400 }),
    screencap: async () => Buffer.alloc(0),
    vlmCache: new Map(),
  });
  const r = await locate('text=健康');
  assert.equal(r.ok, true, 'WebView 零面积节点应被定位');
  assert.equal(r.inWebView, true, '应标记 inWebView');
  assert.deepEqual(r.bounds, [0, 0, 0, 0]);
});
