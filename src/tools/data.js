// 数据与扩展工具（§7 / §10 末二行 / §19.7）：
//   data_extract（ui / ai / collection 三模式）、data_query、data_store、secret_get、sms_read
// 数据落 ctx.store（§1.3 openDataset），凭据即取即用不落盘。

import fs from 'node:fs';
import path from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { flattenNodes, findBySelector, findAllBySelector, matchSelector, textResult } from './perception.js';
import { isZeroAreaBounds, hasWebViewContainer } from '../device/uitree.js';
import { denied, confirmWrite } from './action.js';
import { repairJson } from './ai.js';
import { compressForContext } from '../image/png.js';

function sampleForContext(rows, written) {
  return { written, count: rows.length, sample: rows.slice(0, 3) };
}

// —— ui 模式：从 UI 树确定性提取（零模型调用） ——
async function extractUi(device, params) {
  const tree = await device.dumpTree({});
  const flat = flattenNodes(tree.nodes);
  const fields = params.fields || [];

  const scopes = [];
  if (params.container) {
    // 容器可出现多次（列表卡片）：按 selector 找全部匹配节点，每个容器为一个 scope
    if (params.container.startsWith('index=')) {
      const n = findBySelector(flat, params.container);
      if (n) scopes.push(n);
    } else {
      // 统一走 selector 匹配器：自造 class= 相等比较会让其它选择器方言（text=、
      // resourceId=、re:）静默失配，'#index=' 语义也被忽略。
      scopes.push(...findAllBySelector(flat, params.container));
    }
  }

  // 无 container 时自动发现"重复结构"容器：按字段 selector 找命中节点，对每个命中
  // 节点用 bounds 包含关系向上找最小祖先（不依赖 parent 引用——某些 device 的 makeNode
  // 不挂 parent），把同 cls+resourceId 的兄弟聚成组；≥2 个且各自含字段命中的组即为
  // 卡片列表，取这组兄弟为 scopes。无重复结构时回退整屏 1 行（现状）。
  // 评审 I1：显式传了 container 但 selector 失配（scopes 仍空）时不得自动发现——
  // 否则会把本应"整屏 1 行"的回退改成多行，改变存量用例行为。
  if (!params.container && !scopes.length && fields.length) {
    const area = (n) => Math.max(0, n.bounds[2] - n.bounds[0]) * Math.max(0, n.bounds[3] - n.bounds[1]);
    // WebView 零面积节点不参与几何包含/重叠判断（bounds=[0,0,0,0] 会被任何 [0,0] 容器「包含」，
    // 且 area=0 排序时反而被优选为最小祖先 → 误聚组）。零面积节点直接排除出自动发现。
    const contains = (parent, child) => {
      if (isZeroAreaBounds(parent) || isZeroAreaBounds(child)) return false;
      return Array.isArray(parent.bounds) && Array.isArray(child.bounds)
        && parent.bounds[0] <= child.bounds[0] && parent.bounds[1] <= child.bounds[1]
        && parent.bounds[2] >= child.bounds[2] && parent.bounds[3] >= child.bounds[3];
    };
    const overlaps = (a, b) => {
      if (isZeroAreaBounds(a) || isZeroAreaBounds(b)) return false;
      return !(a.bounds[2] <= b.bounds[0] || b.bounds[2] <= a.bounds[0]
        || a.bounds[3] <= b.bounds[1] || b.bounds[3] <= a.bounds[1]);
    };
    // 最小包含祖先：面积最小的那个包含节点（排除自身）
    const ancestorOf = (n) => flat.filter((p) => p !== n && contains(p, n))
      .sort((a, b) => area(a) - area(b))[0];
    // 无 selector 的字段（如 from:'index' 位置字段）不参与自动发现，避免 undefined selector
    const hitByAncestor = (a) => {
      for (const f of fields) {
        if (!f.selector) continue;
        if (flat.some((n) => n !== a && contains(a, n) && matchSelector(n, f.selector))) return true;
      }
      return false;
    };
    const groups = new Map();
    for (const f of fields) {
      if (!f.selector) continue;
      for (const n of flat) {
        if (!matchSelector(n, f.selector)) continue;
        const a = ancestorOf(n);
        if (!a || !a.cls) continue;
        const key = `${a.cls}::${a.resourceId ?? ''}`;
        if (!groups.has(key)) groups.set(key, new Set());
        groups.get(key).add(a);
      }
    }
    for (const [, set] of groups) {
      // 评审 Minor 1：先剔除 bounds 重叠的候选，保留面积最小者——嵌套父子容器会被
      // 聚到同组、误当成"重复卡片"撑出多行；两两判重叠后只留最小卡片再判 ≥2。
      const candidates = [...set];
      const removed = new Set();
      for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
          const a = candidates[i], b = candidates[j];
          if (overlaps(a, b)) removed.add(area(a) >= area(b) ? a : b);
        }
      }
      const kept = candidates.filter((n) => !removed.has(n));
      // 剩余 ≥2 且各自含字段命中才认作重复卡片结构
      if (kept.length >= 2 && kept.every(hitByAncestor)) { scopes.push(...kept); break; }
    }
  }

  const rows = [];
  const scopeList = scopes.length ? scopes : [null];
  for (const scope of scopeList) {
    // scope 内的节点 = bounds 落在容器 bounds 内的扁平节点。
    // WebView 零面积 container 无法做几何包含 → 退化为全文档提取（避免只拿到 [0,0,0,0] 节点）。
    // 零面积子节点在正常 container 内也放行（几何未知，由文本匹配保证归属）。
    const inner = scope && Array.isArray(scope.bounds) && !isZeroAreaBounds(scope)
      ? flat.filter((n) => n !== scope && Array.isArray(n.bounds)
          && (isZeroAreaBounds(n) || (
            n.bounds[0] >= scope.bounds[0] && n.bounds[1] >= scope.bounds[1]
            && n.bounds[2] <= scope.bounds[2] && n.bounds[3] <= scope.bounds[3])))
      : flat;
    const row = {};
    for (const f of fields) {
      const node = findBySelector(inner, f.selector);
      if (!node) { row[f.name] = null; continue; }
      if (f.from === 'text') row[f.name] = node.text;
      else if (f.from === 'attr') row[f.name] = node[f.attr || 'contentDesc'] ?? null;
      else if (f.from === 'index') row[f.name] = inner.indexOf(node);
      else row[f.name] = node.text;
    }
    rows.push(row);
  }
  return { rows, hash: tree.hash };
}

// —— collection 模式：边滚边抽、按主键去重（§7.1 / §7.3） ——
async function extractCollection(ctx, params) {
  const { device, store } = ctx;
  const seen = new Map();
  let rounds = 0;
  // 两个上限语义不同，不能混用一个参数：
  //   max      —— 收集**条数**上限（真正截断已收集行数）
  //   maxRounds—— 滚动**轮数**上限（防止无限滚动）
  // 原实现把 max 当轮数用，写 "max: 50" 期望"最多收 50 条"，实际是"最多滚 50 屏"
  // ——可能收 500 条，也可能因页面早早到底而只收几条。
  const maxItems = Math.max(1, params.max ?? 20);
  const maxRounds = Math.max(1, params.maxRounds ?? 20);

  while (rounds < maxRounds) {
    rounds++;
    let rows = [];
    if (params.mode === 'ai' && params.query) {
      const r = await extractAiOnce(ctx, params.query);
      rows = Array.isArray(r) ? r : [];
    } else {
      rows = (await extractUi(device, { fields: params.fields, container: params.container })).rows;
    }
    for (const row of rows) {
      const k = params.key ? String(row[params.key] ?? JSON.stringify(row)) : JSON.stringify(row);
      if (!seen.has(k)) seen.set(k, row);
      if (seen.size >= maxItems) break;
    }
    if (seen.size >= maxItems) break;   // 条数已够，不必再滚
    // 滚动一屏看后续内容（direction 内容语义：down=前进）；无变化即停（树 hash 判定）
    const r = await device.scroll('down', { max: 1, stopWhenNoChange: true });
    if (!r.changed) break;
  }
  return [...seen.values()].slice(0, maxItems);
}

// —— ai 模式：截图 + 小模型抽 JSON（§7.1） ——
// 截图先经 compressForContext 降采样+JPEG（1080×2400 PNG ~427KB → 540×1200 q70 ~64KB）：
// 图像 token 随像素数计，原图直发每次 ai 提取多花约 3 倍图像 token；collection 每轮滚动都重发，放大更甚。
async function extractAiOnce(ctx, query) {
  const chat = ctx.chat;
  if (!chat) return { error: 'ai 模式需要模型配置（ASK_MODEL_*）或注入 ctx.chat' };
  try {
    const shot = await ctx.device.screencap();
    // 压缩失败（如非标准 PNG）降级发原图，保证 ai 提取不因编码问题整体失败
    let img;
    try {
      const c = await compressForContext(shot.buffer, { maxWidth: 540, quality: 70 });
      img = { data: c.buffer.toString('base64'), mimeType: c.mimeType };
    } catch {
      img = { data: shot.buffer.toString('base64'), mimeType: 'image/png' };
    }
    const text = await chat(
      `从截图提取结构化数据。要求：${query}\n只输出 JSON。`,
      { images: [img] },
    );
    return repairJson(text);
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

export function buildDataTools(ctx) {
  const { device, store, recorder, opts } = ctx;

  const dataExtract = defineTool({
    name: 'data_extract',
    label: 'data_extract',
    description: '页面数据提取。mode=ui：从 UI 树确定性提取（推荐，零模型调用）；mode=ai：小模型从截图提取；mode=collection：边滚边抽按主键去重。结果写入变量表供 ${var} 引用。',
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: '数据集名；缺省不落库' })),
      mode: Type.String({ description: 'ui|ai|collection' }),
      fields: Type.Optional(Type.Array(Type.Object({
        name: Type.String(),
        from: Type.Optional(Type.String({ description: 'text|attr|index，默认text' })),
        selector: Type.String(),
        attr: Type.Optional(Type.String({ description: 'from=attr 的属性名' })),
      }), { description: 'ui 字段定义' })),
      container: Type.Optional(Type.String({ description: '容器 selector（列表卡片 class）' })),
      query: Type.Optional(Type.String({ description: 'ai 提取要求' })),
      key: Type.Optional(Type.String({ description: 'collection 去重主键' })),
      max: Type.Optional(Type.Number({ description: 'collection 最多收集条数，默认20' })),
      maxRounds: Type.Optional(Type.Number({ description: 'collection 最多滚动轮数，默认20' })),
    }),
    execute: async (_id, params) => {
      let rows = [];
      if (params.mode === 'ui') {
        rows = (await extractUi(device, params)).rows;
      } else if (params.mode === 'ai') {
        if (!params.query) return textResult({ ok: false, error: 'ai 模式需要 query 参数' });
        const r = await extractAiOnce(ctx, params.query);
        if (r && r.error) return textResult({ ok: false, error: r.error });
        rows = Array.isArray(r) ? r : [r];
      } else if (params.mode === 'collection') {
        // collection 模式会滚动设备（写操作：改变屏幕状态），须走确认闸
        const gate = await confirmWrite(ctx, 'data_extract', `collection 模式将滚动设备采集数据${params.name ? ` 到数据集 ${params.name}` : ''}`);
        if (!gate.allowed) return denied('data_extract');
        rows = await extractCollection(ctx, params);
      } else {
        return textResult({ ok: false, error: `未知模式 ${params.mode}` });
      }

      let written = null;
      if (params.name && store) {
        written = await store.append(params.name, rows, { run: recorder?.runId ?? null, step: ctx.currentStepIndex ?? null });
      }
      // 写入运行时变量表（§7.5）：data_extract 写入，后续步骤 ${var} 引用
      if (params.name) {
        ctx.vars.set(params.name, rows);
        // 数据集写入计数留痕（Manus"结果留进上下文"教训）：整体描述（buildStepDigest）
        // 引用此表，让窗口折叠后远处的书断言仍能看到"数据集 X=N 条"的证据。
        // 口径 = 回读数据集现状（append 去重/upsert 合并后的真实行数），不是本次抽取数
        ctx.datasetWrites = ctx.datasetWrites ?? new Map();
        ctx.datasetWrites.set(params.name, store ? (await store.read(params.name)).length : rows.length);
      }
      const last = rows[rows.length - 1];
      return textResult({
        ok: true,
        mode: params.mode,
        count: rows.length,
        dataset: params.name || null,
        written: written ? written.written : null,
        sample: rows.slice(0, 3),
        lastRowVars: last ? Object.fromEntries(Object.entries(last).map(([k, v]) => [`${params.name}.${k}`, v])) : {},
      });
    },
  });

  const dataQuery = defineTool({
    name: 'data_query',
    label: 'data_query',
    description: '查询已存数据集（where 支持 field>lit / field=lit / field!=lit 与 &&，orderBy 字段前加 - 表示倒序）。',
    parameters: Type.Object({
      name: Type.String(),
      where: Type.Optional(Type.String()),
      select: Type.Optional(Type.Array(Type.String())),
      limit: Type.Optional(Type.Number()),
      orderBy: Type.Optional(Type.String()),
    }),
    execute: async (_id, params) => {
      if (!store) return textResult({ ok: false, error: 'store 未注入' });
      // 同 data_store：store.query 会抛（非法 where/orderBy/数据集名），必须转结构化
      // 失败，否则无 recorder 的 ask 路径会以未捕获异常中断
      try {
        const rows = await store.query(params.name, {
          where: params.where || undefined,
          select: params.select,
          limit: params.limit,
          orderBy: params.orderBy || undefined,
        });
        return textResult({ ok: true, name: params.name, count: rows.length, rows: rows.slice(0, 20) });
      } catch (e) {
        return textResult({ ok: false, error: `数据集查询失败: ${String(e?.message ?? e).slice(0, 200)}` });
      }
    },
  });

  const dataStore = defineTool({
    name: 'data_store',
    label: 'data_store',
    description: '把行数据写入数据集（append 追加 / clear 清空 / upsert 按主键去重）。',
    parameters: Type.Object({
      name: Type.String(),
      action: Type.Optional(Type.String({ description: 'append（默认）| upsert | clear' })),
      rows: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }), { description: '要写入的行' })),
      key: Type.Optional(Type.String({ description: 'upsert 主键字段' })),
    }),
    execute: async (_id, params) => {
      if (!store) return textResult({ ok: false, error: 'store 未注入' });
      const action = params.action || 'append';
      // store 层会抛（非法数据集名、非法 where/orderBy、缺主键字段）。必须就地转成
      // 结构化失败：withRecording 的兜底 try/catch **只在有 recorder 时生效**，而
      // bin/ask.js 的 ask 直答路径恰恰是 recorder: null —— 异常会逃出工具层、
      // 以未捕获异常中断整条问答链路，模型也拿不到可自纠的错误文本。
      try {
        if (action === 'clear') {
          await store.clear(params.name);
          // clear 也要更新留痕：否则整体描述继续宣称旧计数（"以此为准"口径下的陈旧权威证据）
          ctx.datasetWrites = ctx.datasetWrites ?? new Map();
          ctx.datasetWrites.set(params.name, 0);
          return textResult({ ok: true, action, name: params.name });
        }
        const rows = params.rows || [];
        let res;
        if (action === 'upsert') {
          if (!params.key) return textResult({ ok: false, error: 'upsert 需要 key 主键字段' });
          res = await store.upsert(params.name, params.key, rows, { run: recorder?.runId ?? null, step: ctx.currentStepIndex ?? null });
        } else {
          res = await store.append(params.name, rows, { run: recorder?.runId ?? null, step: ctx.currentStepIndex ?? null });
        }
        // 数据集写入计数留痕（供整体描述引用，见 data_extract 同款注释）；
        // 口径 = 回读数据集现状（upsert 全量合并时 written=0，按 written 记会"回退"成 0 条）
        ctx.datasetWrites = ctx.datasetWrites ?? new Map();
        ctx.datasetWrites.set(params.name, (await store.read(params.name)).length);
        return textResult({ ok: true, action, name: params.name, ...sampleForContext(rows, res.written) });
      } catch (e) {
        return textResult({ ok: false, error: `数据集写入失败: ${String(e?.message ?? e).slice(0, 200)}` });
      }
    },
  });

  // —— secret_get（§19.7）：provider+key → 返回值仅入上下文；ctx.secretCalls 记账 ——
  const secretGet = defineTool({
    name: 'secret_get',
    label: 'secret_get',
    description: '获取登录凭据（密码等）。值只在上下文中使用，绝不写入用例/数据集/日志。',
    parameters: Type.Object({
      provider: Type.String({ description: '凭据提供方标识' }),
      key: Type.String({ description: '凭据键名' }),
    }),
    execute: async (_id, params) => {
      ctx.secretCalls.push({ tool: 'secret_get', provider: params.provider, key: params.key, stepIndex: ctx.currentStepIndex ?? null });
      // 凭据读取与 sms_read 同属 §19.7 敏感操作，同样走确认闸，保持两类敏感操作待遇一致。
      const gate = await confirmWrite(ctx, 'secret_get', `读取凭据 ${params.provider}/${params.key}`, { kind: 'sensitive' });
      if (!gate.allowed) return denied('secret_get');
      // 来源 1：工作区私有状态目录下的 secrets.json（用户自管，不入库不入 git）；
      // 未注入 stateDir 时回退 cwd/.ask（保持既有行为）
      const secretsDir = ctx.stateDir || path.resolve('.ask');
      const localPath = path.join(secretsDir, 'secrets.json');
      try {
        const json = JSON.parse(fs.readFileSync(localPath, 'utf8'));
        const v = json?.[params.provider]?.[params.key];
        if (typeof v === 'string' && v.length > 0) {
          // 值仅入上下文；登记给 recorder 做全文兜底脱敏（§19.7），绝不落 run.json 明文
          const sc = ctx.secretCalls[ctx.secretCalls.length - 1];
          if (sc) sc.value = v;
          try { recorder?.registerSecret?.({ provider: params.provider, key: params.key, value: v }); } catch { /* ignore */ }
          return textResult({ ok: true, provider: params.provider, key: params.key, value: v, source: 'local' });
        }
      } catch { /* 文件不存在则走失败 */ }
      return textResult({
        ok: false,
        code: 'SECRET_UNAVAILABLE',
        provider: params.provider,
        key: params.key,
        error: `凭据不可用：${localPath} 缺少该条目（也可通过 MCP secret 服务提供）`,
      });
    },
  });

  // —— sms_read（§19.7）：读本机短信/通知验证码，敏感操作需 --yes 或确认 ——
  const smsRead = defineTool({
    name: 'sms_read',
    label: 'sms_read',
    description: '读取本机短信/通知栏验证码（敏感操作）。返回值仅入上下文。',
    parameters: Type.Object({
      sender: Type.Optional(Type.String({ description: '按发送方过滤' })),
      contains: Type.Optional(Type.String({ description: '按内容关键字过滤' })),
    }),
    execute: async (_id, params) => {
      ctx.secretCalls.push({ tool: 'sms_read', provider: 'device', key: 'sms', stepIndex: ctx.currentStepIndex ?? null });
      // 走 confirmWrite（与所有写操作同一套语义）：--yes 直通、ctx.confirm 征求
      // 同意、两者都无时告警一次后放行，保证非交互场景也不静默丢掉这道安全门。
      const gate = await confirmWrite(ctx, 'sms_read', '读取设备短信/通知', { kind: 'sensitive' });
      if (!gate.allowed) return denied('sms_read'); // details.denied=true，记账标 cancelled（与操作工具一致）
      // 设备层若提供扩展能力（content://sms / notification listener）则使用
      if (typeof device.readSms === 'function') {
        const r = await device.readSms(params);
        return textResult({ ok: true, ...r, redact: true });
      }
      if (typeof device.readNotifications === 'function') {
        const r = await device.readNotifications(params);
        return textResult({ ok: true, ...r, redact: true });
      }
      return textResult({
        ok: false,
        code: 'SECRET_UNAVAILABLE',
        error: '当前设备层未提供短信/通知读取能力（src/device 未实现 readSms/readNotifications）',
      });
    },
  });

  // —— test_account（§19.7）：非密级测试账号（手机号等），来自 ASK_TEST_ACCOUNTS ——
  // 手机号非密级（DESIGN §19.7 明确"非密级可配置"）：不走确认闸、不进 secretCalls、
  // 不脱敏。密钥类凭据一律走 secret_get。
  const testAccount = defineTool({
    name: 'test_account',
    label: 'test_account',
    description: '读取非密级测试账号（手机号等），来自环境变量 ASK_TEST_ACCOUNTS（JSON）。密钥类一律走 secret_get。',
    parameters: Type.Object({ key: Type.Optional(Type.String({ description: '账号组名（缺省返回全部）' })) }),
    execute: async (_id, params) => {
      const raw = process.env.ASK_TEST_ACCOUNTS;
      if (!raw) return textResult({ ok: false, code: 'ACCOUNTS_UNAVAILABLE', error: '未配置 ASK_TEST_ACCOUNTS 环境变量' });
      let accounts;
      try { accounts = JSON.parse(raw); } catch { return textResult({ ok: false, error: 'ASK_TEST_ACCOUNTS 不是合法 JSON' }); }
      if (params.key) {
        const v = accounts?.[params.key];
        if (v == null) return textResult({ ok: false, error: `账号组 ${params.key} 不存在` });
        return textResult({ ok: true, accounts: v });
      }
      return textResult({ ok: true, accounts });
    },
  });

  return [dataExtract, dataQuery, dataStore, secretGet, smsRead, testAccount];
}
