// 会话层测试：prompt 三模式+裁剪 / persist 策略选择 / case 解析+${var} 插值 / model env 解析
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assemblePrompt, PROJECT_ROOT } from '../src/session/prompt.js';
import { resolveStrategy, createSessionManager } from '../src/session/persist.js';
import { parseCaseText, caseFromText, interpolate, interpolateCase, buildToolCall, normalizeType, QUERY_TYPES } from '../src/session/case.js';
import { resolveModelConfig, validateModelConfig, baseUrlHash, ModelConfigError } from '../src/session/model.js';

// —— prompt 三层装配（§6.1/6.2） ——
// 设备事实由调用方运行时采集后以 facts 传入（prompt.js 不做设备访问，保持可单测）
const FULL_FACTS = {
  screenSize: { w: 1080, h: 2400 },
  androidVersion: '15',
  deviceModel: 'sdk_gphone64_x86_64',
  netSupported: true,
};

describe('prompt', () => {
  test('append 模式：L1 + L2 + L3 用户段在末尾，facts 填充占位符', () => {
    const r = assemblePrompt({ mode: 'append', prompt: 'USER-LAYER', projectRoot: PROJECT_ROOT, facts: FULL_FACTS });
    assert.ok(r.systemPrompt.includes('UI 测试 agent'), 'L1 引擎层在');
    assert.ok(r.systemPrompt.includes('1080×2400'), 'L2 分辨率来自运行时 facts');
    assert.ok(r.systemPrompt.includes('sdk_gphone64_x86_64'), 'L2 型号来自 facts');
    assert.ok(r.systemPrompt.includes('Android 15'), 'L2 系统版本来自 facts');
    assert.ok(r.systemPrompt.includes('档位语义'), 'net 支持时保留档位语义段');
    assert.ok(r.systemPrompt.trim().endsWith('USER-LAYER'), '用户段追加在末尾（优先级最高）');
    assert.deepEqual(r.contextLayers.map((l) => l.name), ['L1-engine', 'L2-android', 'L3-user']);
    assert.equal(r.warnings.length, 0);
    assert.ok(!r.systemPrompt.includes('{{'), '无残留占位符');
  });

  test('replace 模式：跳过 L1，L2 永远保留，且 warn 提示', () => {
    const r = assemblePrompt({ mode: 'replace', prompt: 'P', projectRoot: PROJECT_ROOT, facts: FULL_FACTS });
    assert.ok(!r.systemPrompt.includes('UI 测试 agent'), 'L1 被跳过');
    assert.ok(r.systemPrompt.includes('1080×2400'), 'L2 强制保留（facts 已填充）');
    assert.ok(r.systemPrompt.includes('P'), '用户段仍在');
    assert.ok(r.warnings.some((w) => w.includes('replace')));
  });

  test('none 模式：L1 与用户段都跳过，仅 L2', () => {
    const r = assemblePrompt({ mode: 'none', prompt: 'SHOULD-NOT-APPEAR', projectRoot: PROJECT_ROOT, facts: FULL_FACTS });
    assert.ok(!r.systemPrompt.includes('UI 测试 agent'));
    assert.ok(!r.systemPrompt.includes('SHOULD-NOT-APPEAR'));
    assert.ok(r.systemPrompt.includes('1080×2400'), '仅剩的 L2 也完成 facts 填充');
    assert.deepEqual(r.contextLayers.map((l) => l.name), ['L2-android']);
  });

  test('facts 缺省：占位符降级为查询提示并 warn，不残留 {{', () => {
    const r = assemblePrompt({ mode: 'none', projectRoot: PROJECT_ROOT });
    assert.ok(!r.systemPrompt.includes('{{'), '占位符不残留');
    assert.ok(r.systemPrompt.includes('先用 screen 工具获取实际分辨率'), '分辨率降级提示');
    assert.ok(r.systemPrompt.includes('型号未探测'), '型号降级提示');
    assert.ok(r.systemPrompt.includes('网络档位支持情况未探测'), 'net 未探测段');
    assert.ok(r.warnings.some((w) => w.includes('设备事实未采集完整')), '缺省降级 warn');
  });

  test('facts.netSupported=false：net 段替换为设备差异说明，档位语义不出现', () => {
    const r = assemblePrompt({
      mode: 'none', projectRoot: PROJECT_ROOT,
      facts: { ...FULL_FACTS, netSupported: false },
    });
    assert.ok(r.systemPrompt.includes('不支持 `net` 命令'), 'net 不可用说明在');
    assert.ok(r.systemPrompt.includes('ok=false'), '点明 net_profile 返回 ok=false 属预期');
    assert.ok(!r.systemPrompt.includes('档位语义'), '不出现档位语义（避免误导模型切档）');
  });

  test('facts 残缺：缺哪项降级哪项，其余正常填充', () => {
    const r = assemblePrompt({
      mode: 'none', projectRoot: PROJECT_ROOT,
      facts: { screenSize: { w: 1080, h: 2400 }, androidVersion: null, deviceModel: null, netSupported: null },
    });
    assert.ok(r.systemPrompt.includes('1080×2400'), '已采集的分辨率正常填充');
    assert.ok(!r.systemPrompt.includes('先用 screen 工具获取实际分辨率'), '分辨率未降级');
    assert.ok(r.systemPrompt.includes('型号未探测') && r.systemPrompt.includes('网络档位支持情况未探测'));
    const warn = r.warnings.find((w) => w.includes('设备事实未采集完整'));
    assert.ok(warn, '残缺也 warn');
    assert.ok(warn.includes('androidVersion') && warn.includes('deviceModel') && warn.includes('netSupported'));
    assert.ok(!warn.includes('screenSize'), '已采集项不进 warn');
  });

  test('超预算裁剪用户段中段并 warn', () => {
    const r = assemblePrompt({
      mode: 'append', projectRoot: PROJECT_ROOT, budget: 500, facts: FULL_FACTS,
      prompt: 'A'.repeat(300) + 'MIDDLE-MARKER' + 'B'.repeat(300),
    });
    assert.ok(r.warnings.some((w) => w.includes('超预算')));
    const l3 = r.contextLayers.find((l) => l.name === 'L3-user');
    assert.ok(l3.chars < 300 + 13 + 300, '用户段被裁短');
    // 保留首尾（§6.1：裁剪用户段中段，保留首尾）
    assert.ok(r.systemPrompt.includes('MIDDLE-MARKER') === false || l3.chars < 613, '中段被移除或整体裁短');
  });

  test('prompt-file 追加', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-prompt-'));
    const f = path.join(dir, 'p.md');
    fs.writeFileSync(f, 'FILE-CONTENT');
    const r = assemblePrompt({ mode: 'append', promptFile: f, projectRoot: PROJECT_ROOT, facts: FULL_FACTS });
    assert.ok(r.systemPrompt.includes('FILE-CONTENT'));
  });
});

// —— persist 四策略（§9.1） ——
describe('persist', () => {
  test('默认 keep', () => {
    assert.equal(resolveStrategy({}).strategy, 'keep');
    assert.equal(resolveStrategy({ keep: true }).strategy, 'keep');
  });
  test('fresh / continue / session', () => {
    assert.equal(resolveStrategy({ fresh: true }).strategy, 'fresh');
    assert.equal(resolveStrategy({ cont: true }).strategy, 'continue');
    assert.equal(resolveStrategy({ session: 'x.jsonl' }).strategy, 'session');
  });
  test('含 secret 调用强制 fresh（§9.1 例外）', () => {
    const r = resolveStrategy({ keep: true, hasSecretCalls: true });
    assert.equal(r.strategy, 'fresh');
    assert.equal(r.forcedBySecret, true);
    assert.ok(r.reason.includes('secret_get'));
    // 已显式 fresh 的不重复标记
    const r2 = resolveStrategy({ fresh: true, hasSecretCalls: true });
    assert.equal(r2.forcedBySecret, false);
  });
  test('fresh → SessionManager.inMemory 不落盘', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-persist-'));
    const sm = await createSessionManager({ strategy: 'fresh', cwd });
    assert.ok(sm, 'inMemory 实例创建成功');
  });
  test('session 策略缺文件名报错', async () => {
    await assert.rejects(() => createSessionManager({ strategy: 'session' }));
  });
});

// —— case 装载与插值（§13.2 / §7.5） ——
describe('case', () => {
  const yaml = `# 弱网相册用例
name: 相册弱网

steps:
  - net: off
  - ai: 打开我的龙岗
  - ai: 点击"电子相册"
  - sleep: 2
  - net: 3g
  - ai: 提取相册列表存为 album
  - aiAssert: 页面有 \${album.count} 张卡片
`;

  test('解析 name + 五种步骤，容忍注释与空行', () => {
    const c = parseCaseText(yaml, { source: 'cases/相册.yaml' });
    assert.equal(c.name, '相册弱网');
    assert.equal(c.steps.length, 7);
    // Midscene 命名：ai / aiAssert
    assert.deepEqual(c.steps.map((s) => s.type), ['net', 'ai', 'ai', 'sleep', 'net', 'ai', 'aiAssert']);
    assert.equal(c.steps[0].profile, 'off');
    assert.equal(c.steps[3].seconds, 2);
    assert.equal(c.steps[6].text, '页面有 ${album.count} 张卡片');
  });

  test('纯文本任务行 "- 文本" 视为 agent 任务（ai）', () => {
    const c = parseCaseText('steps:\n  - 打开设置\n  - ai: 查看网络');
    assert.deepEqual(c.steps.map((s) => s.type), ['ai', 'ai']);
    assert.equal(c.steps[0].text, '打开设置');
    assert.equal(c.steps[1].text, '查看网络');
  });

  test('caseFromText 统一 Case 对象（run/do/ask 同构 §13.2）', () => {
    const c = caseFromText('打开设置查看网络');
    assert.equal(c.steps.length, 1);
    assert.equal(c.steps[0].type, 'ai');
    assert.equal(c.steps[0].text, '打开设置查看网络');
  });

  test('${var} 执行期插值：已知替换、未知保留', () => {
    const vars = new Map([['name', '春游']]);
    assert.equal(interpolate('相册 ${name} 于 2025', vars), '相册 春游 于 2025');
    assert.equal(interpolate('未知 ${nope} 保留', vars), '未知 ${nope} 保留');
  });

  test('interpolateCase 逐步骤插值', () => {
    const c = { name: 't', steps: [{ type: 'ai', text: '查 ${x}' }, { type: 'sleep', seconds: 1 }] };
    const out = interpolateCase(c, new Map([['x', '列表']]));
    assert.equal(out.steps[0].text, '查 列表');
    assert.equal(out.steps[1].text, undefined);
  });
});

// —— model env 解析（全部 mock/注入，不真连） ——
describe('model', () => {
  test('ASK_MODEL_* 环境变量解析，--model-* 覆盖', () => {
    const env = { ASK_MODEL_URL: 'https://a.api/v1', ASK_MODEL_KEY: 'k1', ASK_MODEL_NAME: 'm1', ASK_MODEL_FAMILY: 'f1' };
    assert.deepEqual(resolveModelConfig({}, env), { url: 'https://a.api/v1', key: 'k1', name: 'm1', family: 'f1' });
    const over = resolveModelConfig({ modelUrl: 'https://b.api/v1' }, env);
    assert.equal(over.url, 'https://b.api/v1');
    assert.equal(over.key, 'k1', '未覆盖项回落环境变量');
  });

  test('缺配置抛 ModelConfigError', () => {
    assert.throws(() => validateModelConfig({ url: '', key: '', name: '', family: '' }), ModelConfigError);
  });

  test('baseUrlHash = sha1(url).slice(0,8)', () => {
    const h = baseUrlHash('https://a.api/v1');
    assert.match(h, /^[0-9a-f]{8}$/);
    assert.equal(h.length, 8);
  });

  test('createModel 用注入的 modelRuntime（不真连）', async () => {
    const registered = [];
    const fakeModel = { provider: 'fam', id: 'mdl' };
    const fakeRuntime = {
      registerProvider(family, cfg) { registered.push({ family, cfg }); },
      getModel(family, name) { return family === 'fam' && name === 'mdl' ? fakeModel : null; },
    };
    const { createModel } = await import('../src/session/model.js');
    const r = await createModel({ url: 'https://x.api/v1', key: 'sk', name: 'mdl', family: 'fam' }, { modelRuntime: fakeRuntime });
    assert.equal(r.model, fakeModel);
    assert.equal(r.info.baseUrlHash.length, 8);
    assert.equal(registered[0].family, 'fam');
    assert.equal(registered[0].cfg.baseUrl, 'https://x.api/v1');
    assert.equal(registered[0].cfg.api, 'openai-completions');
  });
});

// —— Midscene 命名（旧名已废弃） ——
describe('midscene naming', () => {
  test('新名解析：ai / aiTap / aiInput / aiAssert / aiScroll / aiKeyboardPress / launch / terminate', () => {
    const yaml = [
      'name: 新语法',
      'steps:',
      '  - ai: 打开首页看看',
      '  - aiTap: 热榜',
      '  - aiInput: 搜索框',
      '    value: Android',
      '  - aiKeyboardPress: 搜索框',
      '    keyName: enter',
      '  - aiScroll: down',
      '    distancePct: 75',
      '  - launch: com.daimajia.gold',
      '  - terminate: com.daimajia.gold',
      '  - aiAssert: 看到热榜列表',
      '  - sleep: 2',
    ].join('\n');
    const c = parseCaseText(yaml, { source: 'new.yaml' });
    assert.deepEqual(c.steps.map((s) => s.type),
      ['ai', 'aiTap', 'aiInput', 'aiKeyboardPress', 'aiScroll', 'launch', 'terminate', 'aiAssert', 'sleep']);
    assert.equal(c.steps[2].value, 'Android', '多行 value 参数');
    assert.equal(c.steps[3].keyName, 'enter');
    assert.equal(c.steps[4].distancePct, 75, '数值参数转 number');
    assert.equal(c.steps[8].seconds, 2);
  });

  test('旧名（do/ask/assert）已废弃：解析报错并提示新名', () => {
    assert.throws(() => parseCaseText('steps:\n  - do: 打开首页\n'), /已废弃[\s\S]*ai:/);
    assert.throws(() => parseCaseText('steps:\n  - ask: 有几条\n'), /已废弃[\s\S]*aiQuery:/);
    assert.throws(() => parseCaseText('steps:\n  - assert: 看到列表\n'), /已废弃[\s\S]*aiAssert:/);
  });

  test('aiQuery 是独立步骤类型：不被静默降级为 ai（回归：ALL_TYPES 曾漏收）', () => {
    const c = parseCaseText('steps:\n  - aiQuery: 提取热榜标题\n    name: hotlist\n', { source: 'q.yaml' });
    assert.equal(c.steps.length, 1);
    assert.equal(c.steps[0].type, 'aiQuery', '应保留 aiQuery 类型，而非降级为 ai');
    assert.equal(c.steps[0].text, '提取热榜标题', '不应把 "aiQuery:" 命令名拼进文本');
    assert.equal(c.steps[0].name, 'hotlist', 'name 参数落库名');
    assert.ok(QUERY_TYPES.has('aiQuery'), 'QUERY_TYPES 应含 aiQuery');
    // 无 name 时同样是 aiQuery，且不报错
    const c2 = parseCaseText('steps:\n  - aiQuery: 页面有几条\n', { source: 'q2.yaml' });
    assert.equal(c2.steps[0].type, 'aiQuery');
  });

  test('normalizeType：aiAct→ai；新名原样返回', () => {
    assert.equal(normalizeType('aiAct'), 'ai');
    assert.equal(normalizeType('aiTap'), 'aiTap');
    assert.equal(normalizeType('aiAssert'), 'aiAssert');
  });

  test('buildToolCall：引擎直执行步骤 → 工具调用', () => {
    assert.deepEqual(buildToolCall({ type: 'aiTap', text: '热榜' }), { tool: 'tap', params: { target: '热榜' } });
    assert.deepEqual(buildToolCall({ type: 'aiInput', text: '搜索框', value: 'Android' }),
      { tool: 'input', params: { target: '搜索框', value: 'Android' } });
    assert.deepEqual(buildToolCall({ type: 'aiKeyboardPress', text: '搜索框', keyName: 'enter' }),
      { tool: 'key', params: { name: 'enter' } });
    assert.deepEqual(buildToolCall({ type: 'aiScroll', direction: 'down', distancePct: 75 }),
      { tool: 'scroll', params: { direction: 'down', distancePct: 75 } });
    assert.deepEqual(buildToolCall({ type: 'launch', appId: 'com.x' }), { tool: 'launch', params: { appId: 'com.x' } });
    assert.deepEqual(buildToolCall({ type: 'terminate', packageName: 'com.x' }), { tool: 'terminate', params: { packageName: 'com.x' } });
    assert.deepEqual(buildToolCall({ type: 'uiDump' }), { tool: 'ui_dump', params: {} }, 'uiDump 引擎直执行');
    assert.deepEqual(buildToolCall({ type: 'uiDump', path: '/tmp/a.xml' }), { tool: 'ui_dump', params: { path: '/tmp/a.xml' } });
    assert.equal(buildToolCall({ type: 'ai', text: '自由任务' }), null, 'agent 步骤不走引擎直执行');
    assert.equal(buildToolCall({ type: 'sleep' }), null);
  });

  test('aiWaitFor 解析为 wait 类型（带 timeout/text）', () => {
    const c = parseCaseText('steps:\n  - aiWaitFor: 页面显示加载完毕\n    timeout: 5000\n');
    assert.equal(c.steps[0].type, 'aiWaitFor');
    assert.equal(c.steps[0].timeout, 5000);
    assert.equal(c.steps[0].text, '页面显示加载完毕');
  });
});

// —— §21 语义化等待：从"等…出现"文本提取 selector ——
describe('wait selector', () => {
  test('waitSelectorFromText：显式 selector 原样 / 引号文本 / 关键词', async () => {
    const { waitSelectorFromText } = await import('../src/session/case.js');
    assert.equal(waitSelectorFromText('等 text=提交 出现'), 'text=提交');
    assert.equal(waitSelectorFromText('等 resourceId=com.x:id/btn 出现'), 'resourceId=com.x:id/btn');
    assert.equal(waitSelectorFromText('等「加载完毕」出现'), '加载完毕', '引号文本 → 裸文本（device 层 auto 链）');
    assert.equal(waitSelectorFromText('等 热榜 加载'), '热榜');
    assert.equal(waitSelectorFromText('等待“提交成功”显示'), '提交成功');
  });

  test('waitSelectorFromText：抽象描述 → null（退回等树稳定）', async () => {
    const { waitSelectorFromText } = await import('../src/session/case.js');
    for (const t of ['详情页稳定', '首页稳定', '热榜列表稳定', '列表第一项出现', '']) {
      assert.equal(waitSelectorFromText(t), null, `「${t}」应无法提取 selector`);
    }
  });
});
