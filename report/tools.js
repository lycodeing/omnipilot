// 报告消费工具（CONTRACT §5.2）：从 HTML 产物提取/拆分 dump、转 Markdown（供 LLM 消费）。
// 提取按 data-group-id 去重保最新，与读取侧 useDump 行为一致（§19.8.6.5）。

import fs from 'node:fs';
import path from 'node:path';
import { DUMP_TAG_TYPE } from './recorder.js';

const DUMP_TAG_RE = new RegExp(`<script type="${DUMP_TAG_TYPE}"([^>]*)>([\\s\\S]*?)<\\/script>`, 'g');

function attrVal(attrs, name) {
  const m = String(attrs ?? '').match(`${name}="([^"]*)"`);
  return m ? m[1] : null;
}

// → [{ groupId, dump }]，同 group 保最新
export function extractDumps(html) {
  const byGroup = new Map();
  for (const m of String(html ?? '').matchAll(DUMP_TAG_RE)) {
    const groupId = attrVal(m[1], 'data-group-id') ?? 'default';
    try {
      byGroup.set(groupId, JSON.parse(m[2])); // <\/ 转义是合法 JSON，直接 parse 还原
    } catch {
      // 损坏标签跳过
    }
  }
  return [...byGroup.entries()].map(([groupId, dump]) => ({ groupId, dump }));
}

// 每 execution 一个 <executionId>.execution.json，返回写入路径数组
export function splitReport(html, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const { dump } of extractDumps(html)) {
    (dump.executions ?? []).forEach((exec, i) => {
      const id = String(exec?.id ?? `execution-${i}`).replace(/[^\w.-]+/g, '_');
      const file = path.join(outDir, `${id}.execution.json`);
      fs.writeFileSync(file, JSON.stringify(exec, null, 2), 'utf8');
      files.push(file);
    });
  }
  return files;
}

function taskLines(task) {
  const out = [`### 任务 ${task?.taskId ?? '?'} · ${task?.type ?? '?'}`];
  out.push(`- 状态：${task?.status ?? '?'}`);
  if (task?.timing?.durationMs != null) out.push(`- 耗时：${task.timing.durationMs}ms`);
  if (task?.thought) out.push(`- thought：${task.thought}`);
  if (task?.param != null) out.push(`- param：\`${JSON.stringify(task.param)}\``);
  if (task?.errorMessage) out.push(`- 错误：${task.errorMessage}`);
  const loc = task?.locate;
  if (loc) {
    const parts = [];
    if (loc.strategy != null) parts.push(`strategy=${loc.strategy}`);
    if (loc.bounds) parts.push(`bounds=[${loc.bounds.join(',')}]`);
    if ('treeCacheHit' in loc) parts.push(`treeCacheHit=${loc.treeCacheHit}`);
    if ('vlmCacheHit' in loc) parts.push(`vlmCacheHit=${loc.vlmCacheHit}`);
    if ('dumpMs' in loc) parts.push(`dumpMs=${loc.dumpMs}`);
    if (parts.length) out.push(`- locate：${parts.join(', ')}`);
  }
  return out;
}

// 标题=groupName；每 task 一节；断言/回滚/网络事件各一节
export function reportToMarkdown(dump) {
  const d = dump ?? {};
  const lines = [`# ${d.groupName ?? '未命名报告'}`];
  if (d.groupDescription) lines.push('', d.groupDescription);
  const meta = [];
  if (d.status != null) meta.push(`- 状态：${d.status}`);
  if (d.durationMs != null) meta.push(`- 总耗时：${d.durationMs}ms`);
  if (d.device?.size) meta.push(`- 设备：${[d.device.model, d.device.size].filter(Boolean).join(' ')}`);
  if (Array.isArray(d.modelBriefs) && d.modelBriefs.length) {
    meta.push(`- 模型：${d.modelBriefs.map((m) => m?.name).filter(Boolean).join(', ')}`);
  }
  if (meta.length) lines.push('', ...meta);

  for (const exec of d.executions ?? []) {
    lines.push('', `## ${exec?.name ?? exec?.id ?? '执行'}`);
    if (exec?.id) lines.push(`executionId: ${exec.id}`);
    for (const task of exec?.tasks ?? []) lines.push('', ...taskLines(task));
  }
  if (Array.isArray(d.assertions) && d.assertions.length) {
    lines.push('', '## 断言');
    for (const a of d.assertions) {
      lines.push(`- [${a?.passed ? '通过' : '失败'}] ${a?.text ?? ''}${a?.reason ? ` —— ${a.reason}` : ''}`);
    }
  }
  if (Array.isArray(d.rollbacks) && d.rollbacks.length) {
    lines.push('', '## 回滚');
    for (const r of d.rollbacks) {
      lines.push(`- 步骤 ${r?.stepIndex ?? '?'}：${r?.reason ?? ''}（${r?.recovered ? '已恢复' : '未恢复'}）`);
    }
  }
  if (Array.isArray(d.networkTimeline) && d.networkTimeline.length) {
    lines.push('', '## 网络事件');
    for (const n of d.networkTimeline) lines.push(`- ${n?.at ?? '?'}ms → ${n?.profile ?? '?'}`);
  }
  return `${lines.join('\n')}\n`;
}

// extractDumps → 逐 dump reportToMarkdown 拼接
export function reportHtmlToMarkdown(html) {
  return extractDumps(html).map(({ dump }) => reportToMarkdown(dump)).join('\n\n');
}
