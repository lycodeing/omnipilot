// 校验 docs/DESIGN.md 中所有 mermaid 代码块能否被 mermaid 官方解析器解析
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
});
globalThis.DOMParser = dom.window.DOMParser;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.SVGElement = dom.window.SVGElement;

const mermaid = (await import('mermaid')).default;
mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });

const md = readFileSync('docs/DESIGN.md', 'utf8');
const blocks = [...md.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)].map((m) => m[1]);

let bad = 0;
for (const [i, code] of blocks.entries()) {
  const head = code.trim().split('\n')[0].slice(0, 40);
  try {
    await mermaid.parse(code);
    console.log(`  OK   #${i + 1}  ${head}`);
  } catch (e) {
    bad++;
    console.log(`  FAIL #${i + 1}  ${head}`);
    console.log(`       ${String(e.message || e).split('\n').slice(0, 6).join('\n       ')}`);
  }
}
console.log(`\n共 ${blocks.length} 个图，失败 ${bad} 个`);
process.exit(bad ? 1 : 0);
