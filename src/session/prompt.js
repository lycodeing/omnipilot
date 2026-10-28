// 三层提示词装配（§6.1/6.2）：
//   L1 引擎层 prompts/system.md    —— append 模式加载；replace/none 跳过
//   L2 安卓层 prompts/system.android.md —— 永远保留（设备事实不交给用户）
//   L3 用户层 --prompt / --prompt-file —— 追加在末尾（优先级最高）
// 总长超过预算（默认 12000 字符）时裁剪用户段中段并 warn。
// L2 的设备事实（{{SCREEN_SIZE}}/{{DEVICE_MODEL}}/{{ANDROID_VERSION}}/{{NET_PROFILE_SECTION}}）
// 由调用方运行时采集（facts 参数）填充；本模块不做任何设备访问，保持纯函数可单测。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(MODULE_DIR, '../..');
export const PROMPT_BUDGET = 12_000;

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function trimMiddle(text, budget) {
  if (text.length <= budget) return text;
  const head = Math.floor(budget * 0.6);
  const tail = Math.max(0, budget - head - 20);
  return text.slice(0, head) + '\n…[用户段过长，中段已裁剪]…\n' + (tail > 0 ? text.slice(-tail) : '');
}

// net 段按探测结果三态：支持 → 档位语义；不支持 → 设备差异说明；未探测 → 先探测提示
function netSectionText(netSupported) {
  if (netSupported === true) {
    return '- 档位语义：`off` 断网恢复默认、`2g`/`3g`/`4g`/`5g` 弱网档、`airplane` 飞行模式、`cut` 阶梯限速、`custom` 自定义。'
      + '\n- 弱网观察必须**先点击再切档**（让请求发生在弱网生效后），观察完立即恢复 `off`。';
  }
  if (netSupported === false) {
    return '- 本设备不支持 `net` 命令（设备差异，redroid 之外常见）：`net_profile` 会返回 ok=false，**属预期而非故障**，'
      + '不要重试切档，也不要设计依赖弱网档位的步骤。';
  }
  return '- 本设备的网络档位支持情况未探测：先用 `net_status` 确认；若 `net_profile` 返回 ok=false，'
    + '说明本设备不支持 `net` 命令（设备差异，属预期），放弃切档并改用其他方式观察。';
}

// L2 占位符填充：facts 由调用方采集传入；缺省/残缺时降级为查询提示并 warn（不虚构设备事实）
function fillDeviceFacts(l2, facts, warnings) {
  const has = facts != null && typeof facts === 'object';
  const size = has && facts.screenSize && Number(facts.screenSize.w) > 0 && Number(facts.screenSize.h) > 0
    ? `${Number(facts.screenSize.w)}×${Number(facts.screenSize.h)}` : null;
  const nonEmpty = (v) => (v != null && String(v).trim() !== '' ? String(v).trim() : null);
  const ver = has ? nonEmpty(facts.androidVersion) : null;
  const model = has ? nonEmpty(facts.deviceModel) : null;
  const net = has && typeof facts.netSupported === 'boolean' ? facts.netSupported : null;

  const missing = [];
  if (!size) missing.push('screenSize');
  if (!ver) missing.push('androidVersion');
  if (!model) missing.push('deviceModel');
  if (net === null) missing.push('netSupported');
  if (missing.length) {
    warnings.push(`设备事实未采集完整（缺 ${missing.join('/')}），L2 对应内容已降级为查询提示`);
  }

  return l2
    .replaceAll('{{SCREEN_SIZE}}', () => size ?? '未预读，先用 screen 工具获取实际分辨率')
    .replaceAll('{{DEVICE_MODEL}}', () => model ?? '型号未探测')
    .replaceAll('{{ANDROID_VERSION}}', () => ver ?? '未探测')
    .replace('{{NET_PROFILE_SECTION}}', () => netSectionText(net));
}

export function assemblePrompt({
  mode = 'append',
  prompt = '',
  promptFile = '',
  projectRoot = PROJECT_ROOT,
  budget = PROMPT_BUDGET,
  facts = null,
} = {}) {
  const warnings = [];
  const layers = [];

  if (mode === 'replace') warnings.push('--prompt-mode replace：已跳过引擎层 L1，安卓层 L2 仍强制保留');
  if (mode === 'none') warnings.push('--prompt-mode none：L1 引擎层与 L3 用户层均跳过');

  if (mode === 'append') {
    const l1 = readIfExists(path.join(projectRoot, 'prompts/system.md'));
    if (l1) layers.push({ name: 'L1-engine', content: l1 });
    else warnings.push('prompts/system.md 不存在，L1 缺失');
  }

  let l2 = readIfExists(path.join(projectRoot, 'prompts/system.android.md'));
  if (l2) {
    l2 = fillDeviceFacts(l2, facts, warnings);
    layers.push({ name: 'L2-android', content: l2 });
  } else {
    warnings.push('prompts/system.android.md 不存在，L2 缺失');
  }

  let user = prompt || '';
  if (promptFile) {
    const fromFile = readIfExists(promptFile);
    if (fromFile) user = (user ? user + '\n' : '') + fromFile;
    else warnings.push(`--prompt-file ${promptFile} 读取失败`);
  }
  if (mode !== 'none' && user) layers.push({ name: 'L3-user', content: user });

  const userLayer = layers.find((l) => l.name === 'L3-user');
  const total = layers.reduce((n, l) => n + l.content.length, 0);
  if (total > budget && userLayer) {
    const overflow = total - budget;
    userLayer.content = trimMiddle(userLayer.content, Math.max(0, userLayer.content.length - overflow));
    warnings.push(`系统提示词超预算（${total} > ${budget} 字符），已裁剪用户段中段`);
  }

  const systemPrompt = layers.map((l) => l.content.trim()).join('\n\n');
  return {
    systemPrompt,
    contextLayers: layers.map((l) => ({ name: l.name, chars: l.content.length })),
    warnings,
  };
}
