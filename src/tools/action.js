// 操作工具（§10）：tap / long_press / input / swipe / scroll / key / launch / terminate
// 只调 ctx.device 门面；写操作确认：--yes 直通，交互确认留 ctx.confirm 钩子。

import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';

// 写操作确认钩子：opts.yes 直通；交互模式由 ctx.confirm 提供扩展点（§13.3）
let _autoAllowWarned = false;
export async function confirmWrite(ctx, toolName, targetDesc) {
  if (ctx.opts.yes) return { allowed: true };
  if (typeof ctx.confirm === 'function') {
    const ok = await ctx.confirm(`调用写操作 ${toolName}（${targetDesc}）`);
    return { allowed: !!ok };
  }
  // 非交互且未提供 confirm（CI/后台/管道）：按设计放行，但必须显式告警一次——
  // 否则"写操作零确认执行"对使用者完全不可见（权限绕过面）
  if (!_autoAllowWarned) {
    _autoAllowWarned = true;
    console.warn('[warn] 非交互环境未启用写操作确认，所有 tap/input/swipe/launch 等写操作将直接执行（如需门禁请用 --yes 以外的交互模式，或自行注入 ctx.confirm）');
  }
  return { allowed: true };
}

export function denied(toolName) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `用户拒绝了 ${toolName} 调用` }) }],
    details: { ok: false, denied: true },
  };
}

// 定位失败统一响应（LOCATE_MISS）：tap 附加补救建议 hint（保持既有形状）
function locateMiss(target, error, { hint = false, fallback = '未找到目标' } = {}) {
  const body = { ok: false, code: 'LOCATE_MISS', target, error: error || fallback };
  if (hint) body.hint = '先用 uitree 查看页面结构，或换更精确的可见文本';
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    details: { ok: false, code: 'LOCATE_MISS' },
  };
}

// 点击类动作成功响应：透传 device 结果 + locate 记账（tap/long_press 共用）
function actedResult(target, loc, r) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: r.ok, target, strategy: loc.strategy, bounds: loc.bounds, latencyMs: r.latencyMs, error: r.error }) }],
    details: { ok: r.ok, locate: loc },
  };
}

// 写操作前的弹窗检查（§2.7）：遇系统弹窗先关闭，避免用例被授权框打断。
// 不计入 steps、不产生断言；关闭失败只 warn + 记 rollback（不阻断原操作）。
async function handlePopupBeforeAction(ctx, device) {
  try {
    const { detectDialog, dismissDialog } = await import('../device/popup.js');
    const d = await detectDialog(device);
    if (!d.detected) return;
    const r = await dismissDialog(device);
    if (r.ok) {
      console.warn(`[warn] 检测到系统弹窗（${d.reason}），已按「${r.clicked}」关闭`);
    } else {
      console.warn(`[warn] 系统弹窗关闭失败：${r.error}`);
      try { ctx.recorder?.addRollback?.({ stepIndex: ctx.currentStepIndex ?? null, reason: `弹窗未关闭：${r.error}`, recovered: false }); } catch { /* ignore */ }
    }
  } catch { /* 弹窗检查失败不阻断主流程 */ }
}

export function buildActionTools(ctx) {
  const { device } = ctx;
  // 带缓存的定位（§1.5）：由 buildTools 注入共享实例；动作工具不再直连 device.locate（绕过缓存）
  const locateWithCache = ctx.locateWithCache ?? ((t) => device.locate(t));

  const tap = defineTool({
    name: 'tap',
    label: 'tap',
    description: '语义定位并点击目标中心点。target 用可见文本或 resourceId，禁止像素坐标。',
    parameters: Type.Object({
      target: Type.String({ description: '目标描述（可见文本 / resource-id）' }),
    }),
    execute: async (_id, params) => {
      const gate = await confirmWrite(ctx, 'tap', params.target);
      if (!gate.allowed) return denied('tap');
      await handlePopupBeforeAction(ctx, device);
      const loc = await locateWithCache(params.target);
      if (!loc.ok || !loc.bounds) return locateMiss(params.target, loc.error, { hint: true });
      const r = await device.tap(loc.bounds);
      return actedResult(params.target, loc, r);
    },
  });

  const longPress = defineTool({
    name: 'long_press',
    label: 'long_press',
    description: '语义定位并长按目标中心点。',
    parameters: Type.Object({
      target: Type.String(),
      durationMs: Type.Optional(Type.Number({ description: '长按时长，默认 800ms' })),
    }),
    execute: async (_id, params) => {
      const gate = await confirmWrite(ctx, 'long_press', params.target);
      if (!gate.allowed) return denied('long_press');
      await handlePopupBeforeAction(ctx, device);
      const loc = await locateWithCache(params.target);
      if (!loc.ok || !loc.bounds) return locateMiss(params.target, loc.error);
      const r = await device.longPress(loc.bounds, params.durationMs ?? 800);
      return actedResult(params.target, loc, r);
    },
  });

  const input = defineTool({
    name: 'input',
    label: 'input',
    description: '定位输入框并输入文本（支持中文），输入后回读校验。需先有输入框目标。',
    parameters: Type.Object({
      target: Type.String({ description: '输入框描述' }),
      value: Type.String({ description: '要输入的内容（可含 ${var} 已插值文本）' }),
      clear: Type.Optional(Type.Boolean({ description: '输入前是否清空（默认 true）' })),
    }),
    execute: async (_id, params) => {
      const gate = await confirmWrite(ctx, 'input', params.target);
      if (!gate.allowed) return denied('input');
      await handlePopupBeforeAction(ctx, device);
      const loc = await locateWithCache(params.target);
      if (!loc.ok || !loc.bounds) return locateMiss(params.target, loc.error, { fallback: '未找到输入框' });
      const r = await device.inputText(loc.bounds, params.value, { clear: params.clear !== false });
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: r.ok, target: params.target, readBack: r.readBack, match: r.ok, error: r.error }) }],
        details: { ok: r.ok, locate: loc },
      };
    },
  });

  const swipe = defineTool({
    name: 'swipe',
    label: 'swipe',
    description: '滑动：from/to 为区域名（bottom/top/left/right）或元素描述。',
    parameters: Type.Object({
      from: Type.String(),
      to: Type.String(),
      durationMs: Type.Optional(Type.Number({ description: '默认 300ms' })),
    }),
    execute: async (_id, params) => {
      const gate = await confirmWrite(ctx, 'swipe', `${params.from}→${params.to}`);
      if (!gate.allowed) return denied('swipe');
      // from/to 为区域名时直接透传；元素描述先定位，失败仍交门面兜底（§1.1 swipe 支持区域名/坐标/元素）
      const resolve = async (desc) => {
        if (['bottom', 'top', 'left', 'right'].includes(desc)) return desc;
        const loc = await locateWithCache(desc);
        if (loc.ok && loc.bounds) return loc.bounds;
        return desc;
      };
      const r = await device.swipe(await resolve(params.from), await resolve(params.to), { durationMs: params.durationMs ?? 300 });
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: r.ok, from: params.from, to: params.to, latencyMs: r.latencyMs, error: r.error }) }],
        details: { ok: r.ok },
      };
    },
  });

  const scroll = defineTool({
    name: 'scroll',
    label: 'scroll',
    description: '滚动页面。direction 为内容语义：down=看更多下方内容（内容上移）/ up=回看上方内容 / left / right；distancePct=滚动距离（整屏100/半屏50，缺省约60）；until=edge 滚到底、until=top 回顶部；画面无变化（树 hash）即停。',
    parameters: Type.Object({
      direction: Type.String({ description: 'down（看更多下方内容，内容上移）/ up（回看上方）/ left / right' }),
      distancePct: Type.Optional(Type.Number({ description: '滚动距离（屏高百分比）：整屏=100、0.75屏=75、半屏=50' })),
      until: Type.Optional(Type.String({ description: "edge（滚到边界即停，用于'翻到最底部'）| top（回到顶部）| 目标 selector 字符串（小步滚动直到该元素在屏可见，抗 WebView fling 过冲）" })),
      max: Type.Optional(Type.Number({ description: '最大滚动次数，默认 5（until 时默认 20）' })),
      stopWhenNoChange: Type.Optional(Type.Boolean({ description: '默认 true' })),
    }),
    execute: async (_id, params) => {
      const gate = await confirmWrite(ctx, 'scroll', params.direction);
      if (!gate.allowed) return denied('scroll');
      // 冷启动期 getSize 失败等异常在此兜住：转结构化失败而非上抛（会把整个 run 判 error）
      let r;
      try {
        if (params.until === 'edge' || params.until === 'top') {
          // 边界跳转（§2.4）：循环滚到画面不再变化（复用 stopWhenNoChange 语义）
          const dir = params.until === 'top' ? 'up' : (params.direction === 'up' ? 'up' : 'down');
          r = await device.scroll(dir, { max: params.max ?? 20, stopWhenNoChange: true });
        } else if (params.until) {
          // selector 形态：小步滚到目标在屏（WebView fling 惯性大，定量距离会过冲整段）
          r = await device.scrollUntil(params.until, {
            direction: params.direction || 'down',
            max: params.max ?? 12,
            ...(params.distancePct != null ? { distancePct: params.distancePct } : {}),
          });
          if (!r.found && !r.error) r.error = `滚动 ${r.scrolls} 步后目标仍不可见: ${params.until}`;
        } else {
          r = await device.scroll(params.direction, {
            max: params.max ?? 5,
            stopWhenNoChange: params.stopWhenNoChange !== false,
            ...(params.distancePct != null ? { distancePct: params.distancePct } : {}),
          });
        }
      } catch (e) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(e?.message ?? e) }) }],
          details: { ok: false, error: String(e?.message ?? e) },
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: !r.error, ...r }) }],
        details: { ok: !r.error, scrolls: r.scrolls, changed: r.changed, ...(r.found != null ? { found: r.found } : {}) },
      };
    },
  });

  const tapEachRow = defineTool({
    name: 'tap_each_row',
    label: 'tap_each_row',
    description: '问卷/表单逐行作答。**缺省（推荐）视觉模式**：不传 rows/tap，VLM 看图逐题定位未作答题目并点选其第一个选项（tap 后像素验证，未验证项下一轮 VLM 复核），App/问卷无关；maxRounds=轮数上限、verifyColor 指定选中色。selector 模式（传 rows=行 scope selector + tap=行内目标 selector）为确定性快路径，适合文案稳定的表单。',
    parameters: Type.Object({
      rows: Type.Optional(Type.String({ description: 'selector 模式：行 scope selector；不传=视觉模式（推荐）' })),
      tap: Type.Optional(Type.String({ description: 'selector 模式：行内目标 selector（取每行最左匹配）' })),
      stopWhen: Type.Optional(Type.String()),
      maxRounds: Type.Optional(Type.Number()),
      verify: Type.Optional(Type.Boolean({ description: '默认 true：tap 后做像素选中色校验' })),
      verifyColor: Type.Optional(Type.String({ description: "选中色：'auto'（蓝色启发式，默认）| '#RRGGBB'" })),
    }),
    execute: async (_id, params) => {
      const gate = await confirmWrite(ctx, 'tap_each_row', params.rows ?? '视觉模式');
      if (!gate.allowed) return denied('tap_each_row');
      // try/catch 与 scroll 工具同款：冷启动 getSize 未就绪等异常转结构化失败，
      // 不上抛（上抛会把整个 run 判 error）
      let r;
      try {
        if (!params.rows || !params.tap) {
          if (params.stopWhen) {
            const msg = 'stopWhen 仅 selector 形态支持；视觉模式的终止条件内建（VLM 判定提交按钮可见且无未答题目）';
            return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: msg }) }], details: { ok: false, error: msg } };
          }
          // —— 视觉模式（缺省）：VLM 看图逐题定位，不依赖 a11y 树（busy 态免疫）——
          const { runVisualAnswer } = await import('./visual-answer.js');
          const { resolveStrategy } = await import('../device/coord/registry.js');
          const strategy = resolveStrategy(ctx.modelCfg?.family);
          r = await runVisualAnswer({
            device: ctx.device,
            chat: ctx.chat,
            strategy,
            maxRounds: params.maxRounds ?? 60,
            verify: params.verify !== false,
            verifyColor: params.verifyColor ?? 'auto',
            onQuestion: ctx.recorder
              ? async (info) => {
                  const handle = ctx.recorder.startStep('answer_row', `${String(info.row).slice(0, 24)} → ${info.option}`);
                  try {
                    let buf = info.buffer;
                    if (!buf) { const shot = await ctx.device.screencap(); buf = shot.buffer; }
                    ctx.recorder.attachScreenshot(handle.index, buf);
                    handle.end({ result: 'ok', error: info.verified ? null : '像素验证未确认（可能已滚动出屏）' });
                  } catch { try { handle.end({ result: 'ok' }); } catch { /* ignore */ } }
                }
              : null,
            log: (m) => console.warn('[visual-answer] ' + m),
          });
        } else {
          // —— selector 模式（确定性快路径）：文案稳定的表单用 ——
          r = await device.tapEachRow({
            rows: params.rows, tap: params.tap, stopWhen: params.stopWhen ?? null, maxRounds: params.maxRounds ?? 60,
            ...(params.verify != null ? { verify: params.verify } : {}),
            ...(params.verifyColor != null ? { verifyColor: params.verifyColor } : {}),
          });
        }
      } catch (e) {
        // 契约骨架兜底：异常时也返回完整形状，避免调用方读到 undefined
        r = { rounds: 0, taps: 0, verified: 0, unverified: 0, done: false, bottom: false, skipped: [], error: String(e?.message ?? e) };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: !r.error, ...r }) }], details: { ok: !r.error, ...r } };
    },
  });
  const key = defineTool({
    name: 'key',
    label: 'key',
    description: '按系统键：back / home / enter / recent。',
    parameters: Type.Object({
      name: Type.String({ description: 'back|home|enter|recent' }),
    }),
    execute: async (_id, params) => {
      if (!['back', 'home', 'enter', 'recent'].includes(params.name)) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `不支持的按键 ${params.name}` }) }], details: { ok: false } };
      }
      const gate = await confirmWrite(ctx, 'key', params.name);
      if (!gate.allowed) return denied('key');
      const r = await device.key(params.name);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: r.ok, key: params.name }) }], details: { ok: r.ok } };
    },
  });

  const launch = defineTool({
    name: 'launch',
    label: 'launch',
    description: '冷启动应用（包名或 包名/activity）。',
    parameters: Type.Object({ appId: Type.String() }),
    execute: async (_id, params) => {
      const gate = await confirmWrite(ctx, 'launch', params.appId);
      if (!gate.allowed) return denied('launch');
      const r = await device.launch(params.appId);
      return { content: [{ type: 'text', text: JSON.stringify({ ...r, appId: params.appId }) }], details: { ok: r.ok } };
    },
  });

  const terminate = defineTool({
    name: 'terminate',
    label: 'terminate',
    description: '强杀应用进程。',
    parameters: Type.Object({ packageName: Type.String() }),
    execute: async (_id, params) => {
      const gate = await confirmWrite(ctx, 'terminate', params.packageName);
      if (!gate.allowed) return denied('terminate');
      const r = await device.terminate(params.packageName);
      return { content: [{ type: 'text', text: JSON.stringify({ ...r, packageName: params.packageName }) }], details: { ok: r.ok } };
    },
  });

  return [tap, longPress, input, swipe, scroll, tapEachRow, key, launch, terminate];
}
