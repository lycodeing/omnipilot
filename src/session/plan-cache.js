// 动作计划缓存（2026-11-04 业界调研落地，Midscene caching / AutoDroid-V2 思想）：
// ai/aiAct 步的模型往返（单轮 wall 的 144-527s 大头）在重复执行同一用例时是纯浪费——
// 同样的步骤文本 + 同样的页面 → 同样的工具调用。按（用例源 + 步骤序号 + 步骤文本 sha1）
// 缓存该步实际使用的工具调用，二次执行直接回放（0 模型往返）；回放失败（LOCATE_MISS
// 等）由调用方自动回退模型规划并覆盖缓存条目。
// 设计边界：只缓存"单工具调用且成功"的步——马拉松/多工具步的后续动作依赖中间页面
// 状态，整段回放不安全（Midscene 同款取舍：计划中途失败不写回缓存）。
// 存 <stateDir>/plan-cache.json，LRU 200 条（按写入时间截断），损坏即重建。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// 缓存键：用例身份 + 步骤位置 + 步骤文本摘要。步骤文本改动 → 键变 → 自然失效。
export function planKey({ caseId, stepIndex, stepText }) {
  const h = createHash('sha1').update(String(stepText ?? '')).digest('hex').slice(0, 10);
  return `${caseId}::${stepIndex}::${h}`;
}

export function createPlanCache(stateDir, { maxEntries = 200 } = {}) {
  const file = path.join(stateDir, 'plan-cache.json');
  let map = new Map();
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(raw.entries ?? {})) {
        if (v && typeof v === 'object' && typeof v.tool === 'string') map.set(k, v);
      }
    }
  } catch {
    map = new Map(); // 缓存损坏不致命：重建空表
  }

  let dirty = false;
  const flush = () => {
    if (!dirty) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      // Map 保持插入序（put 按时间推进），取末尾 N 条 = 最新 N 条；同毫秒多次 put 也确定
      const entries = [...map.entries()].slice(-maxEntries);
      writeFileSync(file, JSON.stringify({ version: 1, entries: Object.fromEntries(entries) }, null, 1));
      dirty = false;
    } catch { /* 落盘失败不阻断（缓存是纯优化） */ }
  };

  return {
    get: (key) => map.get(key) ?? null,
    put(key, call) {
      // call: { tool, params, plan? } —— plan 为该步完整工具调用序列（多调用步整体回放，
      // Midscene 计划同款）；无 plan 时退化为单调用。
      map.set(key, {
        tool: String(call.tool),
        params: call.params ?? {},
        ...(Array.isArray(call.plan) ? { plan: call.plan } : {}),
        at: Date.now(),
      });
      dirty = true;
      flush();
    },
    delete: (key) => { if (map.delete(key)) { dirty = true; flush(); } },
    size: () => map.size,
  };
}
