// 操作工具（§10）：tap / long_press / input / swipe / scroll / key / launch / terminate
// 只调 ctx.device 门面；写操作确认：--yes 直通，交互确认留 ctx.confirm 钩子。

import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { textResult } from './perception.js';
import { assertSafePackage, assertSafeActivity } from '../device/package-guard.js';

// 写/敏感操作确认钩子：opts.yes 直通；交互模式由 ctx.confirm 提供扩展点（§13.3）
// 告警标志挂在 ctx 上（而非模块级）：bin/ask.js 支持多 run 并发，模块级标志会
// 让先告警的 run 抑制掉其它 run 的告警——后者可能根本没有确认能力。
//
// kind：'write'（改设备状态）/ 'sensitive'（读凭据、读短信等敏感读取）/ 'mcp'
// （调用外部 MCP 服务器）。措辞必须区分——对只读操作宣称"写操作"会让用户误解
// 自己批准了什么。
export async function confirmWrite(ctx, toolName, targetDesc, { kind = 'write' } = {}) {
  if (ctx.opts?.yes) return { allowed: true };
  const verb = kind === 'write' ? '调用写操作' : kind === 'sensitive' ? '执行敏感读取' : '调用外部工具';
  if (typeof ctx.confirm === 'function') {
    const ok = await ctx.confirm(`${verb} ${toolName}（${targetDesc}）`);
    return { allowed: !!ok };
  }
  // 非交互且未提供 confirm（CI/后台/管道）：按设计放行，但必须显式告警一次——
  // 否则"写操作零确认执行"对使用者完全不可见（权限绕过面）
  if (!ctx._autoAllowWarned) {
    ctx._autoAllowWarned = true;
    console.warn('[warn] 非交互环境未启用操作确认，所有 tap/input/swipe/launch 等写操作与敏感读取将直接执行（如需门禁请用 --yes 以外的交互模式，或自行注入 ctx.confirm）');
  }
  return { allowed: true };
}

export function denied(toolName) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `用户拒绝了 ${toolName} 调用` }) }],
    // 带 error：withRecording 据此记录被拒原因（否则只记成笼统的 'failed'）
    details: { ok: false, denied: true, error: `用户拒绝了 ${toolName} 调用` },
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

  // 坐标点击（allowCoords 逃生口）：**不注册给模型**（见 buildActionTools 末尾与 index.js 过滤）。
  // 语义：跳过定位，直接点 (x,y)。仅由引擎直执行坐标步（buildToolCall → point_tap）调用，
  // 模型侧工具面保持"禁止像素坐标"（tap 的 description 仍是原话）。
  const pointTap = defineTool({
    name: 'point_tap',
    label: 'point_tap',
    description: '按坐标点击（仅 allowCoords 用例的引擎直执行步调用；模型侧不可用）。',
    parameters: Type.Object({
      x: Type.Number({ description: '屏幕 x 像素' }),
      y: Type.Number({ description: '屏幕 y 像素' }),
    }),
    execute: async (_id, params) => {
      const gate = await confirmWrite(ctx, 'point_tap', `${params.x},${params.y}`);
      if (!gate.allowed) return denied('point_tap');
      await handlePopupBeforeAction(ctx, device);
      const r = await device.tap([Number(params.x), Number(params.y)]);
      // locate 记账：坐标步没有定位过程，但报告/定位统计需要一条可渲染的记录
      const loc = { ok: r.ok, bounds: null, center: [Number(params.x), Number(params.y)], strategy: 'coords', treeCacheHit: false, vlmCacheHit: false, dumpMs: 0, identity: null, error: r.error ?? null };
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: r.ok, target: `(${params.x},${params.y})`, strategy: 'coords', center: loc.center, latencyMs: r.latencyMs, error: r.error }) }],
        details: { ok: r.ok, locate: loc },
      };
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
      // from/to 为区域名时直接透传；元素描述先定位。
      // 定位失败必须返回 LOCATE_MISS：原实现把描述原样丢给设备层，而设备的
      // resolvePoint 只认区域名/坐标 → 报"未知区域名: 列表底部（可用: top/bottom/…）"，
      // 既掩盖了真因（元素没找到），又列出了模型从未用过的区域名，模型无法自纠。
      const resolve = async (desc) => {
        if (['bottom', 'top', 'left', 'right'].includes(desc)) return desc;
        const loc = await locateWithCache(desc);
        if (loc.ok && loc.bounds) return loc.bounds;
        return { miss: desc, error: loc.error };
      };
      const from = await resolve(params.from);
      const to = await resolve(params.to);
      for (const v of [from, to]) {
        if (v && typeof v === 'object' && v.miss) {
          return locateMiss(v.miss, v.error, { fallback: `未找到滑动起点/终点元素：${v.miss}` });
        }
      }
      const r = await device.swipe(from, to, { durationMs: params.durationMs ?? 300 });
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
      profile: Type.Optional(Type.String({ description: "场景预设（按需加载，只含时序调优不含选择器）：questionnaire|form，或 ASK_PROFILE_DIR 下的自定义名" })),
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
          // 场景 profile 与 selector 形态同款分类点，两形态统一走 profiles.resolveTiming，
          // 避免 settle/maxRounds/verifyColor 缺省值分叉。
          let prof = null;
          if (params.profile) {
            const { loadProfile } = await import('../device/profiles/index.js');
            prof = await loadProfile(params.profile); // 未知名抛错 → 外层 catch 转结构化失败（与 selector 形态 device 层报错同款 UX）
          }
          const { resolveTiming } = await import('../device/profiles/index.js');
          const timing = resolveTiming({ maxRounds: params.maxRounds, verifyColor: params.verifyColor }, prof);
          const { runVisualAnswer } = await import('./visual-answer.js');
          const { resolveStrategy } = await import('../device/coord/registry.js');
          const strategy = resolveStrategy(ctx.modelCfg?.family);
          r = await runVisualAnswer({
            device: ctx.device,
            chat: ctx.chat,
            strategy,
            maxRounds: timing.maxRounds,
            verify: params.verify !== false,
            verifyColor: timing.verifyColor,
            settleMs: timing.settleMs,
            ...(prof?.doneTexts?.length ? { doneTexts: prof.doneTexts } : {}),
            onQuestion: ctx.recorder
              ? async (info) => {
                  const handle = ctx.recorder.startStep('answer_row', `${String(info.row).slice(0, 24)} → ${info.option}`);
                  try {
                    let buf = info.buffer;
                    if (!buf) { const shot = await ctx.device.screencap(); buf = shot.buffer; }
                    ctx.recorder.attachScreenshot(handle.index, buf);
                    handle.end({ result: info.ok ? 'ok' : 'failed', error: info.ok ? null : '像素验证未确认（可能已滚动出屏）' });
                  } catch { try { handle.end({ result: 'ok' }); } catch { /* ignore */ } }
                }
              : null,
            log: (m) => console.warn('[visual-answer] ' + m),
          });
        } else {
          // —— selector 模式（确定性快路径）：文案稳定的表单用 ——
          // onQuestion 逐题取证：每题一行 answer_row 子步骤 + 验证截图（hash 变化轮 buffer
          // 为 null 时补拍终态），使逐题作答过程在报告里可见（与视觉模式同款）。
          r = await device.tapEachRow({
            rows: params.rows, tap: params.tap, stopWhen: params.stopWhen ?? null,
            ...(params.maxRounds != null ? { maxRounds: params.maxRounds } : {}),
            ...(params.verify != null ? { verify: params.verify } : {}),
            ...(params.verifyColor != null ? { verifyColor: params.verifyColor } : {}),
            ...(params.profile != null ? { profile: params.profile } : {}),
            onQuestion: ctx.recorder
              ? async (info) => {
                  const handle = ctx.recorder.startStep('answer_row', `${String(info.row).slice(0, 24)} → ${info.option}`);
                  try {
                    let buf = info.buffer;
                    if (!buf) { const shot = await ctx.device.screencap(); buf = shot.buffer; }
                    ctx.recorder.attachScreenshot(handle.index, buf);
                    handle.end({ result: info.ok ? 'ok' : 'failed', error: info.ok ? null : '像素验证未确认（可能已滚动出屏）' });
                  } catch { try { handle.end({ result: 'ok' }); } catch { /* ignore */ } }
                }
              : null,
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
    description: '冷启动应用（包名或 包名/activity）。clean=true 时启动后自动清掉系统弹窗（权限/安装器）。',
    parameters: Type.Object({
      appId: Type.String(),
      clean: Type.Optional(Type.Boolean({ description: '启动后自动清弹窗（detectDialog + dismissDialog 最多 3 轮）' })),
    }),
    execute: async (_id, params) => {
      // 包名白名单（第一道防线）：appId 会进 adb shell 命令串，而 adb shell 是设备端
      // /bin/sh -c 执行的。设备层也有同样的校验（最后防线），但在工具层拦住能给出
      // 准确的参数错误，而不是"设备层拒绝"的误导信息。
      const id = String(params.appId ?? '').trim();
      const [pkg, activity] = id.split('/');
      const bad = (() => {
        try { assertSafePackage(pkg); if (activity) assertSafeActivity(activity); return null; }
        catch (e) { return e.message; }
      })();
      if (bad) return textResult({ ok: false, error: bad });
      const gate = await confirmWrite(ctx, 'launch', params.appId);
      if (!gate.allowed) return denied('launch');
      const r = await device.launch(params.appId);
      // clean：冷启动常伴随权限/安装器弹窗，复用写动作前的同一套 detectDialog+dismissDialog
      // 循环关闭（最多 3 轮，弹窗消失或前台离开弹窗包即停），不再靠用例里的防御咒语。
      if (params.clean && r.ok) {
        for (let i = 0; i < 3; i++) {
          await handlePopupBeforeAction(ctx, device);
          const fg = await device.foreground().catch(() => null);
          if (!fg?.package || !/permissioncontroller|packageinstaller/.test(fg.package)) break;
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ...r, appId: params.appId }) }], details: { ok: r.ok } };
    },
  });

  const terminate = defineTool({
    name: 'terminate',
    label: 'terminate',
    description: '强杀应用进程。',
    parameters: Type.Object({ packageName: Type.String() }),
    execute: async (_id, params) => {
      // 包名白名单（第一道防线，同 launch）
      try { assertSafePackage(params.packageName); }
      catch (e) { return textResult({ ok: false, error: e.message }); }
      const gate = await confirmWrite(ctx, 'terminate', params.packageName);
      if (!gate.allowed) return denied('terminate');
      const r = await device.terminate(params.packageName);
      return { content: [{ type: 'text', text: JSON.stringify({ ...r, packageName: params.packageName }) }], details: { ok: r.ok } };
    },
  });

  return [tap, pointTap, longPress, input, swipe, scroll, tapEachRow, key, launch, terminate];
}

// 引擎专用工具：只给引擎直执行（buildToolCall）用，**不进模型工具面**。
// point_tap 存在的前提正是"模型不许给像素坐标"（tap.description 原话）——
// 若把它注册给模型，等于在模型侧放行像素坐标（DESIGN.md:978 禁止裸坐标）。buildTools 据此过滤。
export const ENGINE_ONLY_TOOLS = new Set(['point_tap']);
