// 把 docs/<某文档>.md 构建成可离线打开的单文件 HTML（内嵌 mermaid 引擎，双击即看）
// 用法：node scripts/build-preview.mjs [源md路径] [输出html路径]
//   默认 docs/DESIGN.md → dist/design-preview.html（保持原行为）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';

const srcArg = process.argv[2] || 'docs/DESIGN.md';
const outArg = process.argv[3] || (srcArg.includes('DESIGN')
  ? 'dist/design-preview.html'
  : `dist/${path.basename(srcArg, '.md').toLowerCase()}-preview.html`);
const md = readFileSync(srcArg, 'utf8');
const mermaidJs = readFileSync('node_modules/mermaid/dist/mermaid.min.js', 'utf8');
// 文档标题（用于 <title> 与侧栏品牌）
const docTitle = (md.match(/^#\s+(.+)$/m)?.[1] || path.basename(srcArg)).trim();

// 抽出 mermaid 源码；正文里只留占位 div（按 idx 关联）。
// 源码通过 JSON 注入到 <script type="application/json">，绝不经过 HTML 文本节点，
// 避免 marked / 浏览器二次转义。
const diagrams = [];
const withPlaceholders = md.replace(/```mermaid\r?\n([\s\S]*?)```/g, (_, code) => {
  const i = diagrams.push(code.trim()) - 1;
  return `\n\n<div class="diagram" data-idx="${i}"></div>\n\n`;
});

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

marked.setOptions({ gfm: true, breaks: false });
let body = marked.parse(withPlaceholders);

// 侧边目录
const toc = [...md.matchAll(/^(#{1,3})\s+(.+)$/gm)]
  .map((m) => ({ level: m[1].length, text: m[2].replace(/`/g, '').trim() }))
  .filter((h) => h.level >= 2);

const slug = (t) =>
  t
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-|-$/g, '');

const tocHtml = toc
  .map((h) => `<a class="toc-l${h.level}" href="#${slug(h.text)}">${escapeHtml(h.text)}</a>`)
  .join('\n');

// 给标题补 id
const used = new Map();
body = body.replace(/<h([1-4])>(.*?)<\/h\1>/g, (full, lv, inner) => {
  const plain = inner.replace(/<[^>]+>/g, '').trim();
  let s = slug(plain);
  const n = used.get(s) || 0;
  used.set(s, n + 1);
  if (n) s = `${s}-${n}`;
  return `<h${lv} id="${s}">${inner}<a class="anchor" href="#${s}">#</a></h${lv}>`;
});

// 安全地把源码塞进 JSON script 块（转义 </script> 与 <!-- 防止提前闭合）
const diagramsJson = JSON.stringify(diagrams)
  .replace(/<\//g, '<\\/')
  .replace(/<!--/g, '<\\!--');

const out = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${docTitle}</title>
<style>
  :root {
    --bg:#fff; --fg:#1f2328; --muted:#656d76; --border:#d1d9e0;
    --accent:#0969da; --code-bg:#f6f8fa; --sidebar-bg:#f6f8fa;
    --table-head:#f6f8fa; --quote-bg:#f6f8fa;
  }
  html[data-theme="dark"] {
    --bg:#0d1117; --fg:#e6edf3; --muted:#8b949e; --border:#30363d;
    --accent:#4493f8; --code-bg:#161b22; --sidebar-bg:#010409;
    --table-head:#161b22; --quote-bg:#161b22;
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--fg);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","Microsoft YaHei",sans-serif;
    font-size:15px;line-height:1.75}
  .layout{display:flex;min-height:100vh}

  aside{width:272px;flex:0 0 272px;background:var(--sidebar-bg);border-right:1px solid var(--border);
    position:sticky;top:0;height:100vh;overflow-y:auto;padding:16px 0 40px}
  aside .brand{padding:0 16px 12px;font-weight:700;font-size:13.5px;border-bottom:1px solid var(--border);
    margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;gap:8px}
  aside .brand small{font-weight:400;color:var(--muted);font-size:11px}
  aside nav{display:flex;flex-direction:column;padding:0 10px}
  aside nav a{color:var(--fg);text-decoration:none;font-size:13px;padding:4px 9px;border-radius:6px;
    border-left:2px solid transparent;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  aside nav a:hover{background:var(--code-bg);color:var(--accent)}
  aside nav a.toc-l2{font-weight:600;margin-top:5px}
  aside nav a.toc-l3{padding-left:22px;color:var(--muted);font-size:12.5px}
  aside nav a.active{border-left-color:var(--accent);background:var(--code-bg);color:var(--accent)}

  main{flex:1;min-width:0;padding:34px 52px 120px;max-width:1180px}
  h1{font-size:29px;border-bottom:1px solid var(--border);padding-bottom:12px;margin:0 0 20px}
  h2{font-size:21px;margin:44px 0 16px;padding-bottom:8px;border-bottom:1px solid var(--border)}
  h3{font-size:17px;margin:30px 0 12px}
  h4{font-size:15px;margin:22px 0 10px}
  .anchor{opacity:0;margin-left:8px;color:var(--accent);text-decoration:none;font-weight:400}
  h1:hover .anchor,h2:hover .anchor,h3:hover .anchor,h4:hover .anchor{opacity:.6}
  p{margin:11px 0}
  a{color:var(--accent)}
  ul,ol{padding-left:26px}
  li{margin:5px 0}
  hr{border:0;border-top:1px solid var(--border);margin:34px 0}
  code{background:var(--code-bg);padding:.18em .42em;border-radius:5px;
    font-family:"Cascadia Code",Consolas,"SF Mono",Menlo,monospace;font-size:.875em;border:1px solid var(--border)}
  pre{background:var(--code-bg);padding:15px 17px;border-radius:8px;overflow-x:auto;
    border:1px solid var(--border);margin:14px 0}
  pre code{background:none;border:0;padding:0;font-size:13px;line-height:1.6}
  blockquote{margin:14px 0;padding:10px 16px;background:var(--quote-bg);border-left:3px solid var(--accent);
    border-radius:0 6px 6px 0;color:var(--muted)}
  blockquote p{margin:4px 0}
  table{border-collapse:collapse;width:100%;margin:16px 0;font-size:13.5px;display:block;overflow-x:auto}
  th,td{border:1px solid var(--border);padding:8px 12px;text-align:left;vertical-align:top}
  th{background:var(--table-head);font-weight:600;white-space:nowrap}
  tbody tr:nth-child(2n){background:color-mix(in srgb,var(--code-bg) 55%,transparent)}

  .diagram{margin:22px 0;border:1px solid var(--border);border-radius:10px;background:var(--bg);overflow:hidden}
  .diagram-toolbar{display:flex;align-items:center;justify-content:space-between;padding:7px 13px;
    background:var(--code-bg);border-bottom:1px solid var(--border);font-size:12px;color:var(--muted)}
  .diagram-toolbar .btns{display:flex;gap:6px}
  .diagram-toolbar button{background:var(--bg);border:1px solid var(--border);color:var(--fg);
    border-radius:5px;padding:2px 9px;font-size:12px;cursor:pointer}
  .diagram-toolbar button:hover{border-color:var(--accent);color:var(--accent)}
  .diagram-body{padding:20px;overflow:auto;text-align:center;cursor:zoom-in}
  .diagram-body svg{max-width:100%;height:auto}
  /* 高图限制高度：用 px 而非 vh —— vh 在后台标签/无头环境会解析成 0 导致失效 */
  .diagram.tall .diagram-body{max-height:900px;cursor:default}
  .diagram-hint{display:none;font-size:11px;color:var(--muted)}
  .diagram.tall .diagram-hint{display:inline}
  .diagram.error{border-color:#cf222e}
  .diagram.error .diagram-body{text-align:left;cursor:default}
  .diagram.error pre{color:#cf222e;font-size:12px}
  .diagram-body.loading{color:var(--muted);font-size:13px}

  .lightbox{position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:999;display:none;
    align-items:center;justify-content:center;padding:24px;overflow:auto;cursor:zoom-out}
  .lightbox.open{display:flex}
  .lightbox svg{max-width:none;background:#fff;border-radius:8px;padding:18px}

  .theme-btn{background:var(--bg);border:1px solid var(--border);color:var(--fg);
    border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}
  .theme-btn:hover{border-color:var(--accent);color:var(--accent)}
  .badge{position:fixed;right:16px;bottom:16px;z-index:99;background:var(--code-bg);
    border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-size:12px;color:var(--muted)}

  @media (max-width:900px){aside{display:none}main{padding:22px 18px 80px}}
  @media print{aside,.diagram-toolbar{display:none}.diagram{break-inside:avoid}}
</style>
</head>
<body>
<div class="layout">
  <aside>
    <div class="brand">
      <span>${docTitle}</span>
      <button class="theme-btn" id="themeBtn">🌙</button>
    </div>
    <nav id="toc">
${tocHtml}
    </nav>
  </aside>
  <main id="content">
${body}
  </main>
</div>
<div class="lightbox" id="lightbox"></div>

<script id="diagram-data" type="application/json">${diagramsJson}</script>
<script>${mermaidJs}</script>
<script>
(function () {
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (isDark) document.documentElement.setAttribute('data-theme', 'dark');
  const btn = document.getElementById('themeBtn');
  btn.textContent = isDark ? '☀️' : '🌙';
  btn.onclick = () => {
    const d = document.documentElement.getAttribute('data-theme') === 'dark';
    document.documentElement.setAttribute('data-theme', d ? '' : 'dark');
    try { localStorage.setItem('ask-theme', d ? 'light' : 'dark'); } catch (e) {}
    location.reload();
  };
  try {
    const saved = localStorage.getItem('ask-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved === 'dark' ? 'dark' : '');
  } catch (e) {}

  const sources = JSON.parse(document.getElementById('diagram-data').textContent);

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default',
    flowchart: { curve: 'basis', padding: 14, nodeSpacing: 42, rankSpacing: 52, useMaxWidth: true },
    sequence: { actorMargin: 44, messageMargin: 34, boxMargin: 10, useMaxWidth: true },
    state: { useMaxWidth: true },
  });

  const boxes = [...document.querySelectorAll('.diagram')];
  let ok = 0, fail = 0;

  boxes.forEach((box, i) => {
    const src = sources[Number(box.dataset.idx)];
    box.innerHTML =
      '<div class="diagram-toolbar"><span>图 ' + (i + 1) + '</span>' +
      '<span class="diagram-hint">内容较长，可滚动查看 · 点「放大」看全图</span>' +
      '<span class="btns"><button data-act="zoom">放大</button>' +
      '<button data-act="src">源码</button></span></div>' +
      '<div class="diagram-body loading">渲染中…</div>';
    const bodyEl = box.querySelector('.diagram-body');

    mermaid.render('mmd-' + i, src)
      .then(({ svg }) => {
        bodyEl.classList.remove('loading');
        bodyEl.innerHTML = svg;
        ok++;
        // 高图（比例 > 1.5）限制显示高度，避免撑长页面；点放大看全图
        const el = bodyEl.querySelector('svg');
        const vb = el && el.viewBox && el.viewBox.baseVal;
        if (vb && vb.height && vb.width && vb.height / vb.width > 1.5) {
          box.classList.add('tall');
        }
        bodyEl.onclick = () => openLightbox(svg);
        box.querySelector('[data-act="zoom"]').onclick = (e) => {
          e.stopPropagation(); openLightbox(svg);
        };
      })
      .catch((err) => {
        box.classList.add('error');
        bodyEl.classList.remove('loading');
        bodyEl.innerHTML = '<pre>渲染失败：' + String(err && err.message || err) +
          '\\n\\n--- 源码 ---\\n' + src.replace(/</g, '&lt;') + '</pre>';
        fail++;
      })
      .finally(() => {
        if (ok + fail === boxes.length) {
          const b = document.createElement('div');
          b.className = 'badge';
          b.textContent = '图 ' + ok + ' 渲染成功' + (fail ? '，' + fail + ' 失败' : '');
          document.body.appendChild(b);
          setTimeout(() => b.remove(), 6000);
        }
      });

    box.querySelector('[data-act="src"]').onclick = (e) => {
      e.stopPropagation();
      let sv = box.querySelector('.srcview');
      if (sv) { sv.remove(); return; }
      sv = document.createElement('div');
      sv.className = 'diagram-body srcview';
      sv.style.cssText = 'text-align:left;cursor:default';
      const pre = document.createElement('pre');
      pre.textContent = src;
      sv.appendChild(pre);
      box.appendChild(sv);
    };
  });

  const lb = document.getElementById('lightbox');
  function openLightbox(svg) {
    lb.innerHTML = svg;
    lb.classList.add('open');
  }
  lb.onclick = () => { lb.classList.remove('open'); lb.innerHTML = ''; };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { lb.classList.remove('open'); lb.innerHTML = ''; }
  });

  // 侧边栏高亮
  const links = [...document.querySelectorAll('#toc a')];
  const heads = links
    .map((a) => document.querySelector(a.getAttribute('href')))
    .filter(Boolean);
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        links.forEach((l) => l.classList.remove('active'));
        const link = links.find((l) => l.getAttribute('href') === '#' + en.target.id);
        if (link) link.classList.add('active');
      });
    },
    { rootMargin: '-10% 0px -75% 0px' },
  );
  heads.forEach((h) => io.observe(h));
})();
</script>
</body>
</html>`;

mkdirSync('dist', { recursive: true });
mkdirSync(path.dirname(outArg), { recursive: true });
writeFileSync(outArg, out, 'utf8');
console.log(`已生成 ${outArg}（${(out.length / 1024 / 1024).toFixed(1)} MB，${diagrams.length} 个图）`);
