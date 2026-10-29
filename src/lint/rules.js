// lint 规则集（§13.4）：行级正则实现，error 阻断 / warn 提示
// 行内豁免：# ask-lint: allow <rule-id> 理由（须有理由，否则豁免无效）

const RULES = [
  {
    id: 'pixel-coords',
    level: 'error',
    test: (line) =>
      /\b(input\s+(tap|swipe)\s+[-\d]+\s+[-\d]+|input\s+tap\s*\{?\s*["']?\d+\s*,\s*\d+)/i.test(line) ||
      /(?:^|[^\d.])-?\d{3,}\s*[,，]\s*-?\d{3,}(?:[^\d.]|$)/.test(line.replace(/[「」【】]/g, ' ')),
    message: '出现 adb 原生 input tap/swipe 像素坐标或文本含像素坐标（2026-09-24 裁定：禁止裸坐标）',
  },
  {
    id: 'platform-fragment',
    level: 'error',
    test: (line) => /^\s*(android:|tasks:)/.test(line),
    message: '顶层出现 android:/tasks: 平台片段模式（平台拼装冲突）',
  },
  {
    id: 'undefined-var',
    level: 'error',
    test: (line) => /\$\{\s*([A-Za-z_][\w]*)\s*\}/.test(line),
    // 变量是否已定义需要全文上下文，见 lintCaseText 内闭环
  },
  {
    id: 'unreachable-scroll',
    level: 'error',
    test: (line, allLines, idx) => {
      // 有显式停止条件（until / maxScrolls）→ 该表述可达成，豁免（§2.4.5）。
      // 停止条件常写在下一步/同一步的后续行（YAML 多行形式），故查当前行 + 后续 2 行。
      for (let j = idx; j <= idx + 2 && j < (allLines?.length ?? 0); j++) {
        if (/\b(until|maxScrolls)\s*[:：]/.test(allLines[j])) return false;
      }
      return /(直到最后|最后一个.{0,6}(出现|显示|加载)|再往下[滑滚]{0,2}\s*\d+\s*行|让(所有|全部|每个).{0,12}(显示|展示|出现|可见))/.test(line);
    },
    message: '滚动目标不可达（直到最后一个/再往下N行/让所有…都显示）；若有显式停止条件（until/maxScrolls）则不拦',
  },
  {
    id: 'bad-ai-func',
    level: 'error',
    test: (line) => /\baiNumeral\b|aiInput\s*\(\s*\{/.test(line),
    message: 'aiNumeral 不存在，或 aiInput 参数为嵌套对象（语法参考）',
  },
  {
    id: 'inferred-assert',
    level: 'warn',
    // 仅对断言行生效：规则语义是"断言含推断式"，命中 ai:/aiTap: 等步骤的描述文本属误报
    // （外部框架用例的拖动/滚动描述常含"已进入/跳转到"字样，非断言）
    test: (line) => /(aiAssert|assert|断言)/.test(line) && /(已进入|已跳转到|成功进入了?|导航到了?)\s*\S{0,10}(页|界面|页面)/.test(line),
    message: '断言含推断式"已进入 XX 页"，应描述当前屏幕可见元素',
  },
  {
    id: 'universal-assert',
    level: 'warn',
    // 仅对断言行生效：步骤描述里的"没有变化/有变化"（如拖动到底判定）不是断言判据
    test: (line) => /(aiAssert|assert|断言)/.test(line) && /(每个|所有|全部)[\u4e00-\u9fa5A-Za-z0-9_]{0,12}(都|均)|红色|绿色|蓝色|白色|黑色|已变化|有变化/.test(line),
    message: '断言含全称量词/颜色词/"已变化"类脆弱判据（踩坑清单 §1）',
  },
  {
    id: 'assert-after-click',
    level: 'warn',
    test: (line, allLines, idx) => {
      const isAssert = /(assert|aiAssert|断言)/.test(line);
      if (!isAssert || idx === 0) return false;
      const prev = allLines[idx - 1];
      // 点击/跳转类动作：旧名（tap/click/点击）+ 新引擎名（aiTap/aiInput/launch/…）
      if (!/(tap|click|点击|跳转|navigate|launch|启动|aiTap|aiInput|aiLongPress|aiKeyboardPress)/.test(prev)) return false;
      // 前一行是点击且之间没有 wait_idle/sleep/aiWaitFor，且当前行之前也没有
      // （aiWaitFor 是等待步骤：外部框架风格用例常用它分隔点击与断言）
      for (let j = idx - 1; j >= 0 && j >= idx - 2; j--) {
        if (/(wait_idle|aiWaitFor|sleep|等待)/.test(allLines[j])) return false;
      }
      return true;
    },
    message: '点击/跳转后紧跟断言而中间无 wait_idle/sleep（转场期断言必挂）',
  },
];

// 收集"变量定义行"（data_extract: xxx / vars 定义 / set: 等）
function definedVars(text) {
  const defs = new Set();
  for (const line of text.split('\n')) {
    // 旧名与新名：data_extract / aiQuery 的参数 name: 定义变量
    for (const m of line.matchAll(/\b(?:data_extract|data_query|aiQuery|aiExtract|set|var)\s*[:：]\s*([\w-]+)/g)) defs.add(m[1]);
    for (const m of line.matchAll(/^\s*-\s*(?:name|as)\s*[:：]\s*([\w-]+)/gm)) defs.add(m[1]);
    // 步骤参数行的 name:（aiQuery 落库名 / data_extract 数据集名）
    for (const m of line.matchAll(/^\s+name\s*[:：]\s*([\w-]+)\s*$/gm)) defs.add(m[1]);
    for (const m of line.matchAll(/([\w-]+)\s*[:=]\s*\$\{/g)) defs.add(m[1]);
  }
  return defs;
}

export function lintCaseText(text) {
  const lines = text.split('\n');
  const defs = definedVars(text);
  const issues = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;

    // 行内豁免解析：# ask-lint: allow <rule-id> 理由
    const allowMatch = line.match(/#\s*ask-lint:\s*allow\s+([\w-]+)\s*(.*)/i);
    const allowed = new Map();
    if (allowMatch) {
      const ruleId = allowMatch[1];
      const reason = (allowMatch[2] || '').trim();
      allowed.set(ruleId, reason.length > 0 ? reason : null); // 无理由 → 豁免无效
    }

    for (const rule of RULES) {
      let hit = false;
      try { hit = !!rule.test(line, lines, i); } catch { hit = false; }
      if (!hit) continue;

      if (rule.id === 'undefined-var') {
        // 规则三：引用未定义变量（定义过的 ${var} 不算）
        for (const m of line.matchAll(/\$\{\s*([A-Za-z_][\w]*)\s*\}/g)) {
          if (!defs.has(m[1])) {
            pushIssue(issues, rule, m[1], i + 1, allowed);
          }
        }
        continue;
      }
      pushIssue(issues, rule, null, i + 1, allowed);
    }
  }
  return issues;
}

function pushIssue(issues, rule, detail, lineNo, allowed) {
  const it = issue(rule, detail, lineNo, allowed);
  if (it) issues.push(it);
}

function issue(rule, detail, lineNo, allowed) {
  const ruleId = rule.id;
  const reason = allowed.get(ruleId);
  // 有效豁免（写了理由）→ 不产生 issue；无理由豁免无效 → 维持原级别并注明
  if (reason) return null;
  if (reason === null) {
    return { level: rule.level, rule: ruleId, message: `${rule.message}；ask-lint: allow 豁免未写理由，豁免无效`, line: lineNo };
  }
  return { level: rule.level, rule: ruleId, message: detail ? `${rule.message}（${detail}）` : rule.message, line: lineNo };
}

export const ruleIds = RULES.map((r) => r.id);
