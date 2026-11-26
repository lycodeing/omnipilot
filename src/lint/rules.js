// lint 规则集（§13.4）：行级正则实现，error 阻断 / warn 提示
// 行内豁免：# ask-lint: allow <rule-id> 理由（须有理由，否则豁免无效）

import { resolvePlatform } from '../platform/index.js';

// 平台片段表从平台包读取（模块加载时解析，lint 当前只服务 android 用例）；
// 后续跨平台 lint 按用例 platform 键动态选平台包，规则本身保持平台无关。
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PLATFORM_FRAGMENTS_RE = new RegExp(
  `^\\s*(${resolvePlatform('android').lintPlatformFragments.map(escapeRe).join('|')})`,
);

// 步骤区起始行下标（steps:/flow:）。parser 只认 steps 之前的顶层键，
// lint 的顶层键判定必须与之一致，否则出现「lint 放行、parser 拒绝」。
function stepsStartIndex(allLines) {
  const lines = allLines ?? [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:steps|flow)\s*[:：]?\s*$/.test(lines[i])) return i;
  }
  return lines.length;
}

const RULES = [
  {
    id: 'pixel-coords',
    level: 'error',
    // 禁止把坐标写进用例（DESIGN.md:978）；用例顶层声明 allowCoords: true 时放行（DESIGN.md:449 逃生口）。
    // 形态覆盖三档：adb 原生 input tap/swipe、文本裸坐标对、以及步骤命令的 { x: N, y: N } 对象形态
    // ——最后一档需覆盖键名间带 `y:` 的写法（`{ x: 135, y: 2115 }`），否则坐标步会 lint 放行却静默失效。
    test: (line, allLines) => {
      // 步骤命令对象形态：`- tap: { x: 135, y: 2115 }`（键名 x/y，值 1 位以上数字）
      const isCoordStep = /^\s*-\s*[A-Za-z][\w-]*\s*[:：]\s*\{[^}]*["']?x["']?\s*[:：]\s*-?\d+[^}]*["']?y["']?\s*[:：]\s*-?\d+/i.test(line);
      // 逃生口只对"坐标步骤"生效：顶层 allowCoords: true 时放行 `tap: { x, y }`。
      // 其余形态（尤其 ai: 文本里的裸 `input tap 512 760`）仍拦——那是把 adb 命令写进任务描述，
      // 声明 allowCoords 不该把它一起放过。
      //
      // allowCoords 必须在 steps:/flow: 之前声明（与 parser 的 !inSteps 判定一致）：
      // 只在 steps 之前的前缀里找，否则 lint 放行、parser 却拒绝 → 作者按 lint 修完仍跑不起来。
      if (isCoordStep) {
        const prefix = (allLines ?? []).slice(0, stepsStartIndex(allLines)).join('\n');
        if (/(?:^|\n)\s*allowCoords\s*[:：]\s*(?:true|yes|on|1)\s*$/im.test(prefix)) return false;
      }
      // allLines 是整份文本的行数组（lintCaseText 传 lines）
      return (
        isCoordStep ||
        /\b(input\s+(tap|swipe)\s+[-\d]+\s+[-\d]+|input\s+tap\s*\{?\s*["']?\d+\s*,\s*\d+)/i.test(line) ||
        /(?:^|[^\d.])-?\d{3,}\s*[,，]\s*-?\d{3,}(?:[^\d.]|$)/.test(line.replace(/[「」【】]/g, ' '))
      );
    },
    message: '出现 adb 原生 input tap/swipe 像素坐标或文本含像素坐标（2026-09-24 裁定：禁止裸坐标；确需请用顶层 allowCoords: true）',
  },
  {
    id: 'platform-fragment',
    level: 'error',
    test: (line) => PLATFORM_FRAGMENTS_RE.test(line),
    message: '顶层出现平台片段模式（平台拼装冲突）',
  },
  {
    id: 'undefined-var',
    level: 'error',
    test: (line) => /\$\{\s*([A-Za-z_][\w]*)\s*\}/.test(line),
    // 变量是否已定义需要全文上下文，见 lintCaseText 内闭环
    message: '引用了未定义的变量（${...}）——未定义时插值会静默保留字面量，输入到 UI 的将是 ${xxx} 原文',
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
    // （外部框架用例的拖动/滚动描述常含"已进入/跳转到"字样，非断言）。
    // 中英双语：纯中文词表对英文用例零覆盖（会静默豁免），故补齐英文推断式。
    test: (line) => /(aiAssert|assert|断言)/.test(line) && (
      /(已进入|已跳转到|成功进入了?|导航到了?)\s*\S{0,10}(页|界面|页面)/.test(line)
      || /(navigated to|entered the|redirected to|now on the)\s*[\w\s]{0,16}(page|screen|dialog)/i.test(line)
    ),
    message: '断言含推断式"已进入 XX 页"，应描述当前屏幕可见元素',
  },
  {
    id: 'universal-assert',
    level: 'warn',
    // 仅对断言行生效：步骤描述里的"没有变化/有变化"（如拖动到底判定）不是断言判据。
    // 中英双语：全称量词/颜色/"已变化"判据同源脆弱（踩坑清单 §1）
    test: (line) => /(aiAssert|assert|断言)/.test(line) && (
      /(每个|所有|全部)[\u4e00-\u9fa5A-Za-z0-9_]{0,12}(都|均)|红色|绿色|蓝色|白色|黑色|已变化|有变化/.test(line)
      || /\ball\b[\w\s]{0,24}\b(are|have|has)\b/i.test(line)
      || /\b(red|green|blue|white|black)\b/i.test(line)
    ),
    message: '断言含全称量词/颜色词/"已变化"类脆弱判据（踩坑清单 §1）',
  },
  {
    id: 'assert-after-click',
    level: 'warn',
    test: (line, allLines, idx) => {
      const isAssert = /(assert|aiAssert|断言)/.test(line);
      if (!isAssert || idx === 0) return false;
      // 剥掉否定语境（"不要点击/勿启动/Don't click"等）再判定，否则防护性叮嘱会误报为点击动作
      const prev = (allLines[idx - 1] || '')
        .replace(/(不要|勿|禁止|严禁|切忌|切莫|别|不能|不得)[\u4e00-\u9fa5]{0,6}?(点击|跳转|启动|navigate|launch|tap)/g, '')
        .replace(/\b(do not|don't|never|avoid|without)\b[\w\s]{0,10}?\b(click|tap|launch|open|navigate|press)\b/gi, '');
      // 点击/跳转类动作：旧名（tap/click/点击）+ 新引擎名（aiTap/aiInput/launch/…）+ 英文动词
      if (!/(tap|click|点击|跳转|navigate|launch|启动|aiTap|aiInput|aiLongPress|aiKeyboardPress|\bopen\b|\bpress\b)/.test(prev)) return false;
      // 前一行是点击且之间没有 wait_idle/sleep/aiWaitFor，且当前行之前也没有
      // （aiWaitFor 是等待步骤：外部框架风格用例常用它分隔点击与断言）
      for (let j = idx - 1; j >= 0 && j >= idx - 2; j--) {
        if (/(wait_idle|aiWaitFor|sleep|等待)/.test(allLines[j])) return false;
      }
      return true;
    },
    message: '点击/跳转后紧跟断言而中间无 wait_idle/sleep（转场期断言必挂）',
  },
  {
    id: 'target-package-missing',
    level: 'warn',
    // pregrant 从步骤 JSON 抓第一个 com.* 时断言/URL 可能抢先误中。用例含
    // launch/terminate 而顶层未声明 targetPackage 时提示显式声明，使包名解析可审计。
    // 只在**首个** launch/terminate 行报一次（不逐行重复刷屏）。
    test: (line, allLines, idx) => {
      if (!/^\s*-\s*(launch|terminate)\s*[:：]/.test(line)) return false;
      if (/(?:^|\n)\s*targetPackage\s*[:：]/.test((allLines ?? []).join('\n'))) return false;
      const first = (allLines ?? []).findIndex((l) => /^\s*-\s*(launch|terminate)\s*[:：]/.test(l));
      return first === idx;
    },
    message: '用例含 launch/terminate 但顶层未声明 targetPackage：--pregrant 将从步骤文本猜测包名（可能误中），建议顶层声明 targetPackage: <包名>',
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
    // 形如 "key: ${...}" 的行——只当**定义**当 key 出现在别处时（key: ${other}）
    // 不算自引用；但 "phone: ${phone}" 是自引用，必须排除，否则 undefined-var
    // 规则把 ${phone} 记成"已定义"，漏报未定义变量（变量未定义时 interpolate
    // 会静默保留字面量 ${phone} 输入到 UI）。
    for (const m of line.matchAll(/([\w-]+)\s*[:=]\s*\$\{\s*([A-Za-z_][\w]*)/g)) {
      if (m[1] !== m[2]) defs.add(m[1]);
    }
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
