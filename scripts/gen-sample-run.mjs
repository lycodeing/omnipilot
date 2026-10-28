// 生成带真实截图的样例 run（走真实 RunRecorder，产出 §14.1 形状），供报告系统联调/演示
// 用法：node scripts/gen-sample-run.mjs <截图目录>
import fs from 'node:fs';
import path from 'node:path';
import { RunRecorder } from '../src/recorder/index.js';

const shotDir = process.argv[2];
if (!shotDir) { console.error('用法: node scripts/gen-sample-run.mjs <截图目录>'); process.exit(2); }
const shot = (f) => fs.readFileSync(path.join(shotDir, f));

const recorder = new RunRecorder({
  runsDir: 'runs',
  caseName: 'cases/相册列表.yaml',
  device: { serial: 'emulator-5554', model: 'redroid', size: '720x1280' },
  model: { family: 'glm', name: 'glm-4.6v', baseUrlHash: 'a1b2c3d4' },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST_BOUNDS = [32, 128, 688, 288];   // "春游" 卡片
const PHOTO_BOUNDS = [32, 128, 240, 336];  // 详情页第一张照片

// step0 screen
let h = recorder.startStep('screen', '初始状态');
recorder.attachScreenshot(h.index, shot('list.png'));
await sleep(300);
h.end({ result: 'ok', thought: '先截屏确认当前处于相册列表页' });

// step1 locate（定位时截图：报告的找元素镜头画在这张动作前画面上）
h = recorder.startStep('locate', '电子相册');
recorder.attachScreenshot(h.index, shot('list.png'));
await sleep(260);
h.end({
  result: 'ok',
  locate: { strategy: 'exact_text', bounds: LIST_BOUNDS, treeCacheHit: false, vlmCacheHit: false, dumpMs: 8 },
  thought: '定位"电子相册"卡片，exact_text 一次命中',
});

// step2 tap
h = recorder.startStep('tap', '电子相册');
await sleep(420);
recorder.attachScreenshot(h.index, shot('detail.png'));
h.end({
  result: 'ok',
  locate: { strategy: 'exact_text', bounds: LIST_BOUNDS, treeCacheHit: true, vlmCacheHit: false, dumpMs: 0 },
  thought: '点击卡片中心 (360,208)，画面切换到春游详情页',
});

// step3 tap 照片
h = recorder.startStep('tap', '第一张照片');
await sleep(380);
recorder.attachScreenshot(h.index, shot('photo.png'));
h.end({
  result: 'ok',
  locate: { strategy: 'class_index', bounds: PHOTO_BOUNDS, treeCacheHit: false, vlmCacheHit: false, dumpMs: 12 },
  thought: '点击网格第一张照片，进入大图查看',
});

// step4 key back
h = recorder.startStep('key', 'back');
await sleep(300);
recorder.attachScreenshot(h.index, shot('list.png'));
h.end({ result: 'ok', thought: '返回相册列表' });

// step5 assert
h = recorder.startStep('assert', '列表按时间倒序');
await sleep(350);
recorder.attachScreenshot(h.index, shot('list.png'));
h.end({ result: 'ok', thought: '列表顺序 2025-09-16 > 2025-09-10 > 2025-08-01，时间倒序成立' });

recorder.addNetworkEvent({ at: 1200, profile: '3g' });
recorder.addNetworkEvent({ at: 9400, profile: 'off' });
recorder.addRollback({ stepIndex: 3, reason: 'locate_miss_x3', recovered: true });
recorder.addAssertion({
  text: '列表按时间倒序',
  passed: true,
  reason: '列表顺序为 2025-09-16 > 2025-09-10 > 2025-08-01，符合时间倒序',
});
recorder.setExtracts({ album_1: '春游', date_1: '2025-09-16' });
recorder.setContextLayers([{ name: 'KIT', chars: 1204 }, { name: 'USER', chars: 388 }]);

const doc = await recorder.finish('pass', { exitCode: 0 });
console.log(doc.jsonPath ?? recorder.jsonPath);
