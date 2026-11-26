// 环境工具（§10）：net_profile / net_status / wait_idle / assert_no_crash / ui_dump
// 变化判定一律基于 UI 树 hash（§5.0.1），禁止截图判变。

import path from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { NET_PROFILES } from '../device/net-profile.js';
import { confirmWrite, denied } from './action.js';

export function buildEnvTools(ctx) {
  const { device, recorder, opts } = ctx;

  const netProfile = defineTool({
    name: 'net_profile',
    label: 'net_profile',
    description: '切换网络档位：off/2g/3g/4g/5g/airplane/cut/custom。弱网任务固定节奏：切档→观察→断言→恢复 off。',
    parameters: Type.Object({
      profile: Type.String({ description: NET_PROFILES.join('|') }),
    }),
    execute: async (_id, params) => {
      if (!NET_PROFILES.includes(params.profile)) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `未知档位 ${params.profile}，可选：${NET_PROFILES.join('/')}` }) }], details: { ok: false } };
      }
      const gate = await confirmWrite(ctx, 'net_profile', params.profile);
      if (!gate.allowed) return denied('net_profile');
      // 切网前记录改动（§2.6）：run 收尾/中断时据此还原到改动前的档位
      try {
        const { recordNetMutation } = await import('../state-mutations.js');
        await recordNetMutation(ctx, device, params.profile);
      } catch (e) {
        console.warn(`[warn] 切网记账失败（${e.message}）：设备可能无法自动还原档位`);
        try { ctx.recorder?.addRollback?.({ stepIndex: ctx.currentStepIndex ?? null, reason: `切网记账失败：${e.message}`, recovered: false }); } catch { /* ignore */ }
      }
      const r = await device.netSetProfile(params.profile);
      // 记账（§14.1 networkTimeline，at = 相对 run 起点的 ms）
      try {
        recorder?.addNetworkEvent?.({ at: Date.now() - (ctx.runStartMs || Date.now()), profile: params.profile });
      } catch { /* recorder 缺失不阻断 */ }
      return { content: [{ type: 'text', text: JSON.stringify({ ...r, requested: params.profile }) }], details: { ok: r.ok, profile: params.profile } };
    },
  });

  const netStatus = defineTool({
    name: 'net_status',
    label: 'net_status',
    description: '查询当前网络档位（记账 + 设备核验）。',
    parameters: Type.Object({}),
    execute: async () => {
      const r = await device.netStatus();
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...r }) }], details: { ok: true, profile: r.profile } };
    },
  });

  const waitIdle = defineTool({
    name: 'wait_idle',
    label: 'wait_idle',
    description: '等待画面稳定：连续两次 UI 树 dump 相同即稳定（quiet=2，间隔 200ms；单次 dump 约 2.2s，故通常 4.5-5s）。点击/跳转后、断言前使用。',
    parameters: Type.Object({
      timeoutMs: Type.Optional(Type.Number({ description: '最长等待，默认 10000' })),
      quiet: Type.Optional(Type.Number({ description: '静默次数，默认 2' })),
    }),
    execute: async (_id, params) => {
      const r = await device.waitIdle({
        quiet: params.quiet ?? 2,
        timeoutMs: params.timeoutMs ?? 10_000,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...r }) }], details: { ok: true, stable: r.stable } };
    },
  });

  const waitElement = defineTool({
    name: 'wait_element',
    label: 'wait_element',
    description: '等待元素出现（selector 同 read：text=/text*=/resourceId=/class=#index=）。支持 selectors 数组（任一命中即返回，降低单 selector 猜错概率）。转场后**优先**用它等页面标志元素（出现即返回 2-6s）；只有无标志元素可等时才退回 wait_idle（动画期常等满超时 10-20s）。',
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: '单个元素 selector' })),
      selectors: Type.Optional(Type.Array(Type.String(), { description: '多个候选 selector，任一出现即返回' })),
      timeoutMs: Type.Optional(Type.Number({ description: '最长等待，默认 10000' })),
    }),
    execute: async (_id, params) => {
      const sels = Array.isArray(params.selectors) && params.selectors.length
        ? params.selectors
        : (params.selector ? [params.selector] : []);
      if (!sels.length) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: '需要 selector 或 selectors 参数' }) }], details: { ok: false } };
      }
      const r = sels.length === 1
        ? await device.waitForElement(sels[0], { timeoutMs: params.timeoutMs ?? 10_000 })
        : await device.waitForAnyElement(sels, { timeoutMs: params.timeoutMs ?? 10_000 });
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: r.appeared, appeared: r.appeared, matched: r.matched ?? null, dumps: r.dumps }) }],
        details: { ok: r.appeared, appeared: r.appeared },
      };
    },
  });

  const assertNoCrash = defineTool({
    name: 'assert_no_crash',
    label: 'assert_no_crash',
    description: '断言目标应用未崩溃：前台包 + 进程存活。弱网/异常场景后必调。',
    parameters: Type.Object({
      expectedPackage: Type.Optional(Type.String({ description: '期望的前台包名，缺省则只查当前前台进程存活' })),
    }),
    execute: async (_id, params) => {
      // 只认工具参数：opts.expectedPackage 从未被任何地方写入（全仓库零写入点），
      // 是个永不生效的回落配置——留着会让人以为可以在 CLI 层统一指定包名。
      const expected = params.expectedPackage || null;
      const r = await device.assertNoCrash(expected);
      const passed = r.ok && r.alive;
      try { recorder?.addAssertion?.({ text: `assert_no_crash ${expected || '(当前)'}`, passed, reason: r.error || null }); } catch { /* 忽略 */ }
      ctx.assertions?.push?.({ text: `assert_no_crash ${expected || '(当前)'}`, passed, reason: r.error || null });
      return { content: [{ type: 'text', text: JSON.stringify({ ...r, passed }) }], details: { ...r, passed } };
    },
  });

  const uiDump = defineTool({
    name: 'ui_dump',
    label: 'ui_dump',
    description: '把当前 UI 树落盘取证（XML），返回文件路径。',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: '落盘路径，缺省写到 run 目录' })),
    }),
    execute: async (_id, params) => {
      const ts = Date.now();
      // 缺省落 run 目录；无 recorder 时落工作区私有状态目录（不污染 cwd）
      const baseDir = recorder?.dir || ctx.stateDir || path.resolve('.ask');
      const fallback = path.join(baseDir, `ui-dump-${ts}.xml`);
      // 落盘范围限定在 run/state 目录内：模型给的 path 若直接采信（尤其绝对路径），
      // 就能把 UI dump 写到进程有权限的任意位置（/etc/passwd 等）。
      // 相对路径解析到 baseDir；绝对路径仅当已在 baseDir 内才接受，否则钳回。
      let target;
      if (!params.path) {
        target = fallback;
      } else {
        const abs = path.isAbsolute(params.path) ? path.resolve(params.path) : path.resolve(baseDir, params.path);
        const root = path.resolve(baseDir) + path.sep;
        target = abs.startsWith(root) ? abs : fallback;
        if (abs !== target) {
          console.warn(`[warn] ui_dump 路径 "${params.path}" 超出 run 目录，已改为 ${target}`);
        }
      }
      const p = await device.dumpToFile(target);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, path: p }) }], details: { ok: true, path: p } };
    },
  });

  return [netProfile, netStatus, waitIdle, waitElement, assertNoCrash, uiDump];
}
