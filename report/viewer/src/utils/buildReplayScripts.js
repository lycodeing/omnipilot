// dump task → 动画脚本编排（DESIGN.md §19.8.1，契约 §3.2）
// 四类编排 + failed 附加帧 + End 段；不生成 0 帧 pointer 脚本，指针挂在动作 img 上。

import { DUR } from './playback-math.js';

export const ACTION_TYPES = ['tap', 'input', 'swipe', 'long_press', 'key', 'back', 'home', 'scroll'];

const LABELS = {
  tap: '点击', input: '输入', swipe: '滑动', assert: '断言',
  screenshot: '截图', sleep: '等待', extract: '提取',
};

export function typeLabel(type) {
  if (type == null) return '';
  return Object.prototype.hasOwnProperty.call(LABELS, type) ? LABELS[type] : type;
}

// subTitle：param.target ?? param.text ?? param 值摘要
function subtitleOf(param) {
  if (param == null) return '';
  if (typeof param === 'object') {
    if (param.target != null) return String(param.target);
    if (param.text != null) return String(param.text);
    try { return JSON.stringify(param); } catch { return String(param); }
  }
  return String(param);
}

function boundsCenter(bounds) {
  const [l, t, r, b] = bounds;
  return { x: Math.round((l + r) / 2), y: Math.round((t + b) / 2) };
}

function baseScript(task, kind, { durationMs, screenshotId, title, subTitle, errorMessage = null, ...rest }) {
  return {
    taskId: task.taskId ?? null,
    end: false,
    kind,
    screenshotId: screenshotId ?? null,
    title,
    subTitle,
    errorMessage,
    durationMs,
    ...rest,
  };
}

export function buildReplayScripts(execution) {
  const tasks = Array.isArray(execution?.tasks) ? execution.tasks : [];
  const scripts = [];
  let lastShot = null;

  for (const task of tasks) {
    if (task == null) continue;
    const type = task.type;
    const shot = task.screenshotId ?? task.locate?.screenshotId ?? null; // 顶层优先（生成端对无 locate 步骤把 id 放顶层）
    const bounds = Array.isArray(task.locate?.bounds) && task.locate.bounds.length === 4
      ? task.locate.bounds : null;
    const isAction = ACTION_TYPES.includes(type);
    const title = typeLabel(type);
    const subTitle = subtitleOf(task.param);

    let group = [];
    if (bounds && isAction) {
      // [整屏静帧, insight 运镜, 动作帧(带指针)]
      // 前两段用"动作前画面"（上一步的截图）：bounds 是动作前算出的，画在本步动作后截图上会错位
      const beforeShot = lastShot ?? shot;
      group.push(baseScript(task, 'img', { durationMs: DUR.stillAfterInsight, screenshotId: beforeShot, title, subTitle }));
      group.push(baseScript(task, 'insight', { durationMs: DUR.locate, screenshotId: beforeShot, title, subTitle, bounds }));
      group.push(baseScript(task, 'img', {
        durationMs: DUR.action, screenshotId: shot, title, subTitle,
        bounds, pointer: boundsCenter(bounds),
      }));
    } else if (bounds) {
      group.push(baseScript(task, 'img', { durationMs: DUR.stillAfterInsight, screenshotId: shot, title, subTitle }));
      group.push(baseScript(task, 'insight', { durationMs: DUR.locate, screenshotId: shot, title, subTitle, bounds }));
    } else if (isAction) {
      // 无 bounds：等待转圈 → 动作帧（无指针字段）
      group.push(baseScript(task, 'spinning-pointer', { durationMs: DUR.spinningPointer, screenshotId: shot, title, subTitle }));
      group.push(baseScript(task, 'img', { durationMs: DUR.action, screenshotId: shot, title, subTitle }));
    } else {
      group.push(baseScript(task, 'img', { durationMs: DUR.still, screenshotId: shot, title, subTitle }));
    }

    // 无图过滤：img/insight 无 screenshotId 跳过（spinning-pointer 保留）；整组为空则单张无图静帧
    group = group.filter((s) => s.kind === 'spinning-pointer' || (s.screenshotId != null && s.screenshotId !== ''));
    if (group.length === 0) {
      group.push(baseScript(task, 'img', { durationMs: DUR.still, screenshotId: null, title, subTitle }));
    }
    // failed 附加帧：screenshotId 用该 task 的截图
    if (task.status === 'failed' && task.errorMessage != null && task.errorMessage !== '') {
      group.push(baseScript(task, 'img', {
        durationMs: DUR.still, screenshotId: shot, title, subTitle, errorMessage: task.errorMessage,
      }));
    }

    scripts.push(...group);
    if (shot) lastShot = shot;
  }

  // End 段：taskId 置空，复用最后一张截图，进入停止态
  scripts.push({
    taskId: null,
    end: true,
    kind: 'img',
    screenshotId: lastShot,
    title: '结束',
    subTitle: execution?.name ?? '',
    errorMessage: null,
    durationMs: DUR.lastFrame,
  });
  return scripts;
}
