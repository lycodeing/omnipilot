// 数据与扩展工具（§7 / §10 末二行 / §19.7）：
//   data_extract（ui / ai / collection 三模式）、data_query、data_store、secret_get、sms_read
// 数据落 ctx.store（§1.3 openDataset），凭据即取即用不落盘。

import fs from 'node:fs';
import path from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { flattenNodes, findBySelector, textResult } from './perception.js';
import { denied } from './action.js';
import { repairJson } from './ai.js';

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
      const clsMatch = params.container.startsWith('class=');
      for (const n of flat) {
        const hit = clsMatch
          ? n.cls === params.container.slice(6).split('#index=')[0]
          : false;
        if (hit) scopes.push(n);
      }
    }
  }

  const rows = [];
  const scopeList = scopes.length ? scopes : [null];
  for (const scope of scopeList) {
    // scope 内的节点 = bounds 落在容器 bounds 内的扁平节点
    const inner = scope && Array.isArray(scope.bounds)
      ? flat.filter((n) => n !== scope && Array.isArray(n.bounds)
          && n.bounds[0] >= scope.bounds[0] && n.bounds[1] >= scope.bounds[1]
          && n.bounds[2] <= scope.bounds[2] && n.bounds[3] <= scope.bounds[3])
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
  const maxRounds = Math.max(1, params.max ?? 20);

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
    }
    // 滚动一屏；无变化即停（树 hash 判定）
    const r = await device.scroll('up', { max: 1, stopWhenNoChange: true });
    if (!r.changed) break;
  }
  return [...seen.values()];
}

// —— ai 模式：截图 + 小模型抽 JSON（§7.1） ——
async function extractAiOnce(ctx, query) {
  const chat = ctx.chat;
  if (!chat) return { error: 'ai 模式需要模型配置（ASK_MODEL_*）或注入 ctx.chat' };
  try {
    const shot = await ctx.device.screencap();
    const b64 = shot.buffer.toString('base64');
    const text = await chat(
      `从截图提取结构化数据。要求：${query}\n只输出 JSON。`,
      { images: [b64] },
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
      name: Type.Optional(Type.String({ description: '存入的数据集名；缺省只返回不落库' })),
      mode: Type.String({ description: 'ui | ai | collection' }),
      fields: Type.Optional(Type.Array(Type.Object({
        name: Type.String(),
        from: Type.Optional(Type.String({ description: 'text | attr | index，默认 text' })),
        selector: Type.String(),
        attr: Type.Optional(Type.String({ description: 'from=attr 时读取的属性名' })),
      }), { description: 'ui 模式字段定义' })),
      container: Type.Optional(Type.String({ description: '容器 selector（如列表卡片 class）' })),
      query: Type.Optional(Type.String({ description: 'ai 模式的提取要求，如 返回 {name: string, price: number}[]' })),
      key: Type.Optional(Type.String({ description: 'collection 去重主键字段' })),
      max: Type.Optional(Type.Number({ description: 'collection 最多条数，默认 20' })),
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
        rows = await extractCollection(ctx, params);
      } else {
        return textResult({ ok: false, error: `未知模式 ${params.mode}` });
      }

      let written = null;
      if (params.name && store) {
        written = await store.append(params.name, rows, { run: recorder?.runId || null, step: ctx.currentStepIndex ?? null });
      }
      // 写入运行时变量表（§7.5）：data_extract 写入，后续步骤 ${var} 引用
      if (params.name) ctx.vars.set(params.name, rows);
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
      const rows = await store.query(params.name, {
        where: params.where || undefined,
        select: params.select,
        limit: params.limit,
        orderBy: params.orderBy || undefined,
      });
      return textResult({ ok: true, name: params.name, count: rows.length, rows: rows.slice(0, 20) });
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
      if (action === 'clear') {
        await store.clear(params.name);
        return textResult({ ok: true, action, name: params.name });
      }
      const rows = params.rows || [];
      let res;
      if (action === 'upsert') {
        if (!params.key) return textResult({ ok: false, error: 'upsert 需要 key 主键字段' });
        res = await store.upsert(params.name, params.key, rows, { run: recorder?.runId || null, step: ctx.currentStepIndex ?? null });
      } else {
        res = await store.append(params.name, rows, { run: recorder?.runId || null, step: ctx.currentStepIndex ?? null });
      }
      return textResult({ ok: true, action, name: params.name, ...sampleForContext(rows, res.written) });
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
      if (!opts.yes && typeof ctx.confirm === 'function') {
        const ok = await ctx.confirm('读取设备短信/通知（敏感操作）？');
        if (!ok) return denied('sms_read'); // details.denied=true，记账标 cancelled（与操作工具一致）
      }
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

  return [dataExtract, dataQuery, dataStore, secretGet, smsRead];
}
