// 循环计划与 selector 文本提取（从 case.js 抽出）。
//
// 抽出的理由：resolveLoopPlan（显式 loop 声明 + legacy 关键词路径）与
// waitSelectorFromText（散文提取 selector）属"步骤语义"单元，与用例文本
// 解析分离。

// 从"等待"文本里解析出可定位的元素 selector（§21）：
//   '热榜列表第一项出现' → 无明确文本 → null（退回等树稳定）
//   '等「加载完毕」出现' → text=加载完毕
//   '等 text=提交 出现' → text=提交（显式 selector 原样用）
// 返回 selector 字符串或 null（null = 无法解析，调用方退回 waitIdle）。
export function waitSelectorFromText(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  // 已是显式 selector（text=/text*=/resourceId=/class=）
  const explicit = /(?:^|\s)((?:text|resourceId|resource-id|id|class|type|desc|re)=[^\s，。]+)/.exec(t);
  if (explicit) return explicit[1];
  // 引号里的文本：「xxx」/'xxx'/“xxx”/直引号 'xxx'（外部框架常用直引号）
  const quoted = /[「“"']([^」”"']{1,40})[」”"']/.exec(t);
  if (quoted) return quoted[1]; // 裸文本（device 层 auto 链：精确→包含）
  // 形如 '等 XXX 出现' / '等 XXX 加载' / 'XXX 可见'
  const m = /(?:等|等待)\s*([^\s，。]{1,30}?)\s*(?:出现|加载|显示|可见|就绪|完成)/.exec(t);
  if (m) {
    const kw = m[1].replace(/^(页面|界面|列表|元素)/, '').trim();
    if (kw) return kw; // 裸文本（device 层 auto 链）
  }
  return null;
}

// 马拉松续作计划（bin/ask.js ai/aiAct 续作循环用，纯函数）：显式步级参数优先，
// 散文关键词仅作存量用例兼容——引擎只读字段不猜词（2026-11-10 评审 P1 落地）。
//
// 显式形态（推荐）：ai 步挂 until/maxRounds/batch 参数行：
//   - ai: 逐题作答直到出现提交按钮
//     until: text=立即提交   # 终止标记：显式 selector 或可见文本（确定性检测，不依赖模型自报）
//     maxRounds: 8           # 催促轮数上限（缺省 10）
//     batch: false           # false=逐个处理（显式缺省，防"依次逐个"被催成整屏并行误点）；true=每轮并行
//
// 兼容形态（DEPRECATED，仅为存量用户用例保留，不删除）：步骤文本含
// 直到/重复/逐题/每一题/依次 触发，批量催促 + "直到…「xxx」"引号提取标记。
// 英文用例静默不触发、"依次"类任务被误催成并行，均为已知缺陷。交付用例（c3/m1 等）
// 已全部迁移为显式 until/maxRounds/batch；新用例一律用显式参数，勿再依赖关键词猜测。
export function resolveLoopPlan(step, stepText) {
  const text = String(stepText ?? '');
  const s = step || {};
  const hasExplicit = s.until != null || s.maxRounds != null || s.batch != null;
  // DEPRECATED：keyword 路径只作存量用例兼容，见上方说明；新用例请挂显式参数。
  const keyword = /直到|重复|逐题|每一题|依次/.test(text);
  if (!hasExplicit && !keyword) return null;
  // 终止标记：显式 until 优先（显式 selector 原样、裸文本直接作 auto 链 selector）；
  // keyword 兼容路径维持"直到…「xxx」"引号提取。
  let marker = null;
  if (s.until != null && String(s.until).trim()) {
    marker = waitSelectorFromText(String(s.until)) || String(s.until).trim();
  } else if (!hasExplicit) {
    marker = waitSelectorFromText((/直到[^，。；]*?[「“"']([^」”"']{1,20})[」”"']/.exec(text) || [null, null])[1] || '');
  }
  // batch 缺省：显式声明 → 逐个（保守）；keyword 兼容路径 → 维持历史批量行为（存量语义不变）
  const batch = s.batch != null
    ? !/^(false|no|off|0)$/i.test(String(s.batch))
    : (hasExplicit ? false : true);
  const maxRounds = Math.max(1, Math.trunc(Number(s.maxRounds ?? 10)) || 10);
  return { marker, batch, maxRounds, source: hasExplicit ? 'explicit' : 'keyword' };
}
