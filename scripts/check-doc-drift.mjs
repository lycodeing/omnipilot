// scripts/check-doc-drift.mjs
// 文档承诺 → 代码消费者对账（评审 I5/M1 修复守护）。
// 检查项：工具数/lint 规则数/底座版本/契约文件路径。漂移即 exit 1。
import { readFileSync, existsSync } from 'node:fs';
import { EXPECTED_TOOLS } from '../src/tools/index.js';
import { ruleIds } from '../src/lint/rules.js';

const errors = [];
const readme = readFileSync('README.md', 'utf8');
const arch = readFileSync('docs/ARCHITECTURE.md', 'utf8');
const contract = readFileSync('docs/CONTRACT-CORE.md', 'utf8');
const design = readFileSync('docs/DESIGN.md', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

// 1. 工具数
for (const [name, text] of [['README.md', readme], ['docs/ARCHITECTURE.md', arch]]) {
  const m = /(\d+)\s*个(?:\s*agent)?\s*工具/.exec(text);
  if (m && Number(m[1]) !== EXPECTED_TOOLS.length) {
    errors.push(`${name}: 工具数 ${m[1]} ≠ 实际 ${EXPECTED_TOOLS.length}`);
  }
}
// 2. lint 规则数
const lintM = /(\d+)\s*条规则|八条规则|九条规则/.exec(contract);
if (contract.includes('八条规则') && ruleIds.length !== 8) errors.push(`CONTRACT-CORE: lint "八条规则" ≠ 实际 ${ruleIds.length}`);
// 3. 底座版本
const piVer = pkg.dependencies['@earendil-works/pi-coding-agent'].replace(/[\^~]/, '');
const designM = /v(\d+\.\d+\.\d+)/.exec(design);
if (designM && designM[1] !== piVer) errors.push(`DESIGN.md: 底座版本 v${designM[1]} ≠ package.json ${piVer}`);
// 4. 契约文件路径
for (const m of contract.matchAll(/`src\/[\w/.-]+\.js`/g)) {
  const p = m[0].slice(1, -1);
  if (!existsSync(p)) errors.push(`CONTRACT-CORE: 文件路径不存在 ${p}`);
}

if (errors.length) {
  console.error('文档漂移：\n' + errors.map((e) => '  - ' + e).join('\n'));
  process.exit(1);
}
console.log(`文档对账通过（工具 ${EXPECTED_TOOLS.length}，lint 规则 ${ruleIds.length}，底座 ${piVer}）`);
