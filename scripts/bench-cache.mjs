// 实测：树缓存 vs 定位缓存各自省下的是哪段时间
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const DEV = '172.16.198.174:5555';

async function adb(...args) {
  const { stdout } = await pexec('adb', ['-s', DEV, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'buffer',
  });
  return stdout;
}
const txt = (b) => b.toString('utf8');
const CLOSE = '</hierarchy>';

function sliceXml(s) {
  const i = s.indexOf('<?xml');
  const j = s.lastIndexOf(CLOSE);
  return i >= 0 && j >= 0 ? s.slice(i, j + CLOSE.length) : null;
}

// 极简解析：只取 node 的 text/class/bounds/clickable —— 这正是定位需要的字段
function parseNodes(xml) {
  const nodes = [];
  const re = /<node\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const g = (k) => {
      const r = new RegExp(`${k}="([^"]*)"`).exec(attrs);
      return r ? r[1] : '';
    };
    const b = g('bounds');
    const nums = b.match(/-?\d+/g);
    nodes.push({
      text: g('text'),
      desc: g('content-desc'),
      cls: g('class'),
      clickable: g('clickable') === 'true',
      bounds: b,
      rect: nums ? nums.map(Number) : null,
    });
  }
  return nodes;
}

const t = async (label, fn) => {
  const t0 = performance.now();
  const r = await fn();
  const ms = performance.now() - t0;
  console.log(`  ${label.padEnd(34)} ${ms.toFixed(1).padStart(8)} ms`);
  return { r, ms };
};

console.log('=== 实测各项耗时（真机 redroid 720x1280）===\n');

// 1) dump 本身
let xml;
const dump = await t('① adb dump --compressed', async () => {
  const raw = txt(await adb('exec-out', 'uiautomator dump --compressed /dev/tty'));
  return sliceXml(raw);
});
xml = dump.r;

// 2) 解析
const parse = await t('② 解析 XML → Node[]', async () => parseNodes(xml));
const nodes = parse.r;
console.log(`     → 节点数 ${nodes.length}, XML ${(xml.length / 1024).toFixed(1)} KB`);

// 3) 精确文本匹配
const cands = nodes.filter((n) => n.text && n.text.trim().length > 1);
const target = cands.length ? cands[0].text : 'x';
const exact = await t(`③ 精确文本匹配 "${target.slice(0, 14)}"`, async () =>
  nodes.find((n) => n.text === target),
);
console.log(`     → 命中: ${exact.r ? exact.r.bounds : '未命中'}`);

// 4) 模糊匹配（遍历全部）
const fuzzy = await t('④ 模糊匹配（遍历全树）', async () =>
  nodes.filter((n) => n.text.includes('页') || n.desc.includes('页')),
);
console.log(`     → 候选 ${fuzzy.r.length} 个`);

// 5) 前台 Activity（廉价信号）
await t('⑤ dumpsys activity（前台）', async () =>
  txt(await adb('shell', 'dumpsys activity activities | grep -m1 ResumedActivity')),
);

// 6) tap
await t('⑥ input tap（对照）', async () =>
  adb('shell', 'input tap 360 640'),
);

console.log('\n=== 结论 ===');
console.log(`  dump 一次           ≈ ${dump.ms.toFixed(0)} ms   ← 树缓存省的是这段`);
console.log(`  解析 + 匹配（全流程）  ≈ ${(parse.ms + exact.ms).toFixed(0)} ms   ← 定位缓存省的是这段`);
console.log(`  比值: dump / (解析+匹配) ≈ ${(dump.ms / (parse.ms + exact.ms)).toFixed(0)} 倍`);
