// skills/ → .pi/skills/<name>/SKILL.md 同步（Pi SDK 只发现后者，skills/README 有说明）。
// 此前靠 README 里的手工 cp 命令——人肉同步迟早失同步，收敛为一个 npm script。
// 用法：npm run skills:sync
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // 项目根
const src = path.join(root, 'skills');
const dest = path.join(root, '.pi', 'skills');
let n = 0;
for (const f of readdirSync(src)) {
  if (!f.endsWith('.md') || f === 'README.md') continue;
  const name = f.replace(/\.md$/, '');
  const dir = path.join(dest, name);
  mkdirSync(dir, { recursive: true });
  cpSync(path.join(src, f), path.join(dir, 'SKILL.md'));
  console.log(`synced skills/${f} -> .pi/skills/${name}/SKILL.md`);
  n++;
}
console.log(`skills:sync 完成（${n} 个）`);
