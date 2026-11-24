// 视觉问卷作答引擎（aiTapEach 的缺省形态）：VLM 看图逐题定位，全程不依赖 a11y 树。
// 动机（2026-11-01）：selector 形态（rows/tap 文本选择器）把引擎钉死在单一问卷的文案上，
// 且 busy 态下 a11y 树全盲（dump 40-55s/次甚至全灭）。视觉形态： screencap 独立于 a11y，
// 天然免疫 dump 缺陷；通用性：任何问卷/表单，无需预知题干与选项文案。
//
// 每轮：截屏 → VLM 找第一道未作答题目的最左选项（归一化 bbox）→ 像素换算 → tap →
// settle → 像素验证（选项芯片变选中色）→ 重复。同一题连续出现 ≥3 次 = tap 未生效
// （渲染器挂死/误点），报错退出。VLM 回复"全部已答+提交可见"→ done；"需要滚动"→ 下翻。

import { compressForContext } from '../image/png.js';
import { decodePng, pixelAt, isBlueish, isColorish, parseHexColor } from '../device/png.js';

// 解析 VLM 回复：容忍代码围栏/前后杂文；返回 { kind: 'answer'|'done'|'scroll'|'invalid', row, option, bbox }
export function parseVisualReply(raw) {
  let text = String(raw ?? '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1].trim();
  const brace = text.indexOf('{');
  if (brace >= 0) text = text.slice(brace, text.lastIndexOf('}') + 1); // 掐头去尾：VLM 常在 JSON 前后带解释性杂文
  let obj = null;
  try { obj = JSON.parse(text); } catch {
    // 兜底：杂文里含示例花括号时，首个 { 到最后一个 } 的切片可能非法——
    // 从每个 '{' 起尝试「平衡截断」解析，取第一个成功的
    for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
      let depth = 0; let end = -1; let inStr = false; let esc = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      if (end < 0) break;
      try { obj = JSON.parse(text.slice(start, end)); break; } catch { /* 试下一个起点 */ }
    }
    if (!obj || typeof obj !== 'object') return { kind: 'invalid', row: '', option: '', bbox: null };
  }
  if (!obj || typeof obj !== 'object') return { kind: 'invalid', row: '', option: '', bbox: null };
  if (obj.done === true) return { kind: 'done', row: '', option: '', bbox: null };
  const bbox = Array.isArray(obj.bbox) && obj.bbox.every((v) => typeof v === 'number' && Number.isFinite(v)) ? obj.bbox : null;
  if (obj.scroll === true || !bbox) return { kind: 'scroll', row: String(obj.row ?? ''), option: '', bbox: null };
  return {
    kind: 'answer',
    row: String(obj.row ?? ''),
    option: String(obj.option ?? ''),
    bbox,
  };
}

// 选项中心点变为选中色的像素校验（3×3 采样）：busy 态下唯一可靠的 tap 回执
async function blueAt(device, pt, expect) {
  try {
    const { buffer } = await device.screencap();
    const png = decodePng(buffer);
    let hits = 0; let total = 0;
    for (const dx of [-20, 0, 20]) for (const dy of [-20, 0, 20]) {
      const px = pixelAt(png, pt[0] + dx, pt[1] + dy);
      if (!px) continue;
      total++;
      if (expect ? isColorish(px, expect) : isBlueish(px)) hits++;
    }
    return total > 0 && hits >= Math.min(3, Math.max(2, Math.ceil(total * 0.5)));
  } catch { return true; } // 截图失败放行（不阻断作答）
}

function buildPrompt(coordHint, doneDesc) {
  return [
    '你是问卷自动作答引擎的视觉定位器。这是一张问卷页面截图。',
    '任务：找出第一道【未作答】的题目——它的选项组中没有任何被选中/高亮/变色的选项。',
    '若找到：只输出一个 JSON 对象 {"done":false,"scroll":false,"row":"<题干前20字>","option":"<你选定的选项文字>","bbox":[x1,y1,x2,y2]}，',
    `bbox 是该选项的矩形框（${coordHint}），必须框住选项本身的可点击区域。`,
    `若屏幕上所有题目都已作答、且能看到${doneDesc}：{"done":true,"scroll":false,"row":"","option":"","bbox":null}`,
    '若所有题目都已作答但没看到提交按钮、或屏幕上没有题目（需要滚动加载）：{"done":false,"scroll":true,"row":"","option":"","bbox":null}',
    '判定"未作答"看选项外观（无高亮/无填充色）；不要把题号"1/27"当成进度条。只输出 JSON，不要解释。',
  ].join('\n');
}

// 主循环。deps: { device, chat, strategy, maxRounds, verify, verifyColor, settleMs, onQuestion, log }
// strategy：coord registry 的 resolveStrategy(modelCfg.family) 结果（toPixels/describeForPrompt）。
// 返回与 device.tapEachRow 同构：{ rounds, taps, verified, unverified, done, bottom, error, answers }
export async function runVisualAnswer(deps) {
  const { device, chat, strategy, maxRounds = 60, verify = true, verifyColor = 'auto', settleMs = 700, doneTexts = null, onQuestion = null, log = () => {} } = deps;
  const result = { rounds: 0, taps: 0, verified: 0, unverified: 0, done: false, bottom: false, error: null, skipped: [], answers: [] };
  if (!chat) { result.error = '视觉模式需要模型配置（ASK_MODEL_*）'; return result; }
  if (!strategy) { result.error = '坐标策略缺失（modelCfg.family 无法识别），无法视觉定位'; return result; }
  const expect = verifyColor === 'auto' || verifyColor == null ? null : (Array.isArray(verifyColor) ? verifyColor : parseHexColor(verifyColor));
  if (verifyColor != null && verifyColor !== 'auto' && !expect) {
    result.error = `verifyColor 无法解析: ${verifyColor}`;
    return result;
  }
  const coordHint = strategy?.describeForPrompt?.() ?? 'bbox 归一化到 0-1000（左上角为原点）';
  // toPixels 是策略对象的方法（内部读 this 状态），必须 method 调用——解构会丢 this
  const toPixels = (bboxStr, sz) => (strategy ? strategy.toPixels(bboxStr, sz ?? size) : null);
  // 完成判定参考按钮（评审 #1②）：profile.doneTexts 可注入（如英文问卷 Submit/Next），
  // 缺省维持内置中文措辞——场景类型知识走 profile 数据，不焊死在 prompt 里
  const doneDesc = doneTexts?.length ? `完成判定参考按钮：${doneTexts.join('、')}` : '提交/下一页按钮（如"立即提交"）';
  const prompt = buildPrompt(coordHint, doneDesc);
  const size = await device.screenSize().catch(() => null);
  if (!size) { result.error = 'screenSize 获取失败，无法视觉定位'; return result; }
  let lastRow = '';
  let repeats = 0;
  for (let round = 1; round <= maxRounds; round++) {
    result.rounds = round;
    let shot;
    try { shot = await device.screencap(); } catch (e) { result.error = `截屏失败: ${e?.message ?? e}`; return result; }
    // （screencap 已守卫）
    let c;
    try { c = await compressForContext(shot.buffer, { maxWidth: 720, quality: 75 }); } catch (e) { result.error = `截图压缩失败: ${e?.message ?? e}`; return result; }
    // （compress 已守卫）
    let raw = '';
    try {
      raw = await chat(prompt, { images: [{ type: 'image', data: c.buffer.toString('base64'), mimeType: c.mimeType }] });
    } catch (e) { result.error = `VLM 调用失败: ${e?.message ?? e}`; return result; }
    // （chat 已守卫）
    const reply = parseVisualReply(raw);
    if (reply.kind === 'invalid') { result.error = `VLM 回复无法解析: ${String(raw).slice(0, 80)}`; return result; }
    if (reply.kind === 'done') { result.done = true; log(`VLM 判定全部已答（提交按钮可见）`); return result; }
    if (reply.kind === 'scroll') {
      let sr;
      try { sr = await device.scroll('down', { max: 1, stopWhenNoChange: true }); } catch (e) { result.error = `scroll 失败: ${e?.message ?? e}`; return result; }
      log(`VLM 要求下翻（第 ${round} 轮）`);
      if (!sr.changed) {
        // 翻不动仍要求滚动：到底后 VLM 仍未见可答题 → bottom
        const shot2 = await device.screencap();
        const c2 = await compressForContext(shot2.buffer, { maxWidth: 720, quality: 75 });
        const raw2 = await chat(prompt, { images: [{ type: 'image', data: c2.buffer.toString('base64'), mimeType: c2.mimeType }] });
        const r2 = parseVisualReply(raw2);
        if (r2.kind === 'answer') {
          const conv = strategy.toPixels(Array.isArray(r2.bbox) ? r2.bbox.join(' ') : '', size);
          if (!conv?.center) {
            // 与主路径同一失败语义：VLM 给了 answer 但 bbox 换算失败 → 硬失败。
            // 原实现静默落到 result.bottom = true（"滚到底了"），上层据此算出
            // ok:true / done:false / bottom:true ——模型看到"成功到底"而实际是换算 bug。
            result.error = 'bbox 无法换算为屏幕坐标（scroll 兜底路径）';
            return result;
          }
          await device.tap(conv.center);
          result.taps++; result.verified++;
          if (r2.row) result.answers.push({ row: r2.row, option: r2.option });
          if (onQuestion) {
            try {
              const { buffer } = await device.screencap();
              await onQuestion({ row: r2.row, option: r2.option, verified: true, taps: 1, buffer });
            } catch { /* 进度回调失败不阻断 */ }
          }
          const rowKey2 = (/\d+\s*\/\s*\d+/.exec(r2.row) || [null])[0] || r2.row;
          const lastKey2 = (/\d+\s*\/\s*\d+/.exec(lastRow) || [null])[0] || lastRow;
          if (rowKey2 && rowKey2 === lastKey2 && ++repeats >= 3) {
            result.error = `renderer_unresponsive: 同一题「${r2.row.slice(0, 20)}」连续 ${repeats} 轮未消失`; return result;
          }
          lastRow = r2.row;
          await new Promise((res) => setTimeout(res, settleMs));
          continue;
        }
        // 非 answer（模型说"到底了"）才算 bottom
        result.bottom = true;
        return result;
      }
      continue;
    }
    // —— answer：像素换算 + tap + 蓝检（条件原地补 tap）——
    // VLM bbox 有 ±几十 px 抖动：首击后蓝检（scroll-into-view 竞态复检一次），
    // 未蓝则上偏二击再检；仍未蓝记 unverified（下一轮 VLM 复核，same-row 计数兜底挂死）
    const conv = toPixels(Array.isArray(reply.bbox) ? reply.bbox.join(' ') : '', size);
    if (!conv?.center) { result.error = `bbox 无法换算: ${JSON.stringify(reply.bbox)}`; return result; }
    const chipH = Array.isArray(conv.bounds) ? Math.max(20, conv.bounds[3] - conv.bounds[1]) : 60;
    let tapsHere = 0;
    let blue = false;
    for (let att = 0; att < 3 && !blue; att++) {
      const pt = att === 0
        ? conv.center
        : [conv.center[0], conv.center[1] + (att === 1 ? -1 : 1) * Math.round(chipH * 0.2)];
      try { await device.tap(pt); } catch (e) { result.error = `tap 失败: ${e?.message ?? e}`; return result; }
      tapsHere++;
      result.taps++;
      await new Promise((r) => setTimeout(r, settleMs));
      if (!verify) { blue = true; break; } // verify=false 跳过像素校验（信任 tap 语义）
      blue = await blueAt(device, pt, expect);
      if (!blue && att === 0) blue = await blueAt(device, pt, expect);
    }
    if (blue) {
      result.verified++;
      if (reply.row) result.answers.push({ row: reply.row, option: reply.option });
      if (onQuestion) {
        try {
          const { buffer } = await device.screencap();
          await onQuestion({ row: reply.row, option: reply.option, verified: true, taps: tapsHere, buffer });
        } catch { /* 进度回调失败不阻断 */ }
      }
    } else {
      result.unverified++;
      if (onQuestion) {
        try { await onQuestion({ row: reply.row, option: reply.option, verified: false, taps: tapsHere, buffer: null }); } catch { /* ignore */ }
      }
    }
    // 同一题连续出现 = tap 未生效（挂死/误点），3 次即报错退出
    const rowKey = (/\d+\s*\/\s*\d+/.exec(reply.row) || [null])[0] || reply.row
      || (reply.option + (reply.bbox ? ':' + reply.bbox.map((v) => Math.round(v / 10)).join(',') : '')); // 按题号归一；无题号时选项+量化坐标兜底
    const lastKey = (/\d+\s*\/\s*\d+/.exec(lastRow) || [null])[0] || lastRow;
    if (rowKey && rowKey === lastKey) {
      if (++repeats >= 3) {
        result.error = `renderer_unresponsive: 同一题「${reply.row.slice(0, 20)}」连续 ${repeats} 轮未消失，tap 疑似未生效`;
        return result;
      }
    } else {
      repeats = 0;
      lastRow = reply.row;
    }
  }
  if (!result.done && !result.bottom && !result.error) result.exhausted = true;
  result.skipped = [];
  return result;
}

