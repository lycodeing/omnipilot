// run 循环编排的纯函数/闭包工厂（从 bin/ask.js 下沉）。
// 本模块只放无编排状态的小工具：读会话末条文本、取证截图闭包、网关折叠闭包。
// 闭包所需的外部依赖（device/recorder/gov）由调用方注入，便于 fake session/device 单测。

// 取会话里最近一条**含文本**的 assistant 消息（thought 归因 + ask 回答回显共用）
// 兼容两种读取路径：SDK 新版的 session.agent.state.messages 与旧版 session.messages。
// 注意：assistant 消息可能是纯 toolCall（无 text）——必须继续往前扫，
// 否则模型用工具回应断言时会把"无文本"误判成"模型无输出"。
export function lastAssistantText(session) {
  try {
    const msgs = session?.agent?.state?.messages ?? session?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      // 只在本轮（最后一次 user 消息之后）内找文本，避免取到上一步的陈旧 thought
      if (m?.role === 'user') break;
      if (m?.role !== 'assistant') continue;
      const parts = Array.isArray(m.content)
        ? m.content.filter((c) => c?.type === 'text').map((c) => c.text ?? '')
        : (typeof m.content === 'string' ? [m.content] : []);
      const text = parts.join('\n').trim();
      if (text) return text;
    }
  } catch { /* 会话不可读则无 thought */ }
  return null;
}

// 非 tool 路径（aiWaitFor 等直记账的步）的报告取证截图：fire-and-forget，
// 与工具层同款模式（serial 队列保证时序、失败不阻断、finish 前统一排空）
export function makeAttachStepShot(device, recorder) {
  return (stepIndex) => {
    try {
      const chain = device.screencap()
        .then((shot) => recorder.attachScreenshot(stepIndex, shot.buffer))
        .catch(() => { /* 取证截图失败不影响 */ });
      recorder.trackPending?.(chain);
    } catch { /* 截图失败不影响 */ }
  };
}

// 步内第 2 轮起的 prompt（催答/续作/视觉确认）自带本轮原始 role:'toolResult' 历史，
// 网关对 role:tool 历史返回 400 → 每次追加 prompt 前先同步全折叠为纯文本。
// governor 落 appendContextEdit：SDK 请求前重建投影时折叠必然生效（原地改写会被投影覆盖）。
export function makeFoldForGateway(gov) {
  return () => { try { gov.foldToolHistory(); } catch { /* 折叠失败不阻断 */ } };
}
