// 步骤类型词表——单一来源（报告契约 §3 的 type 字段）。
//
// 为什么存在：run.json 的 step.type 由三处生成（工具记账 withRecording=工具名、
// ask.js 直记账 sleep/net/aiWaitFor、tap_each_row 逐题取证子步 answer_row），而消费端
// （report/viewer 的标签、图标、回放编排，report/CONTRACT.md 的枚举文档）曾各写一份
// 词表——新增工具类型（如 point_tap）会在报告端静默降级。本模块是唯一的词表源。
//
// 边界说明：引擎注册表本身（src/tools/index.js 的 buildTools）依赖 node 侧重型模块，
// 不能被浏览器端 viewer 直接 import；因此本文件刻意保持**零 import 的纯数据**，
// 与真实注册表的一致性由 test/tools-vocab.test.js 强制（词表缺失 → 测试红）。
// 新增工具/记账步的流程：注册工具（或加 startStep）→ 在此补一行 → 测试守护。
//
// MCP 桥放行的工具名是动态的（来自 mcp.json），不进本表——消费端对未知 type 一律
// 回退显示原始名（typeLabel 的 fallback），图标落 default 圆点。

// 工具名 → 中文标签（§10 契约工具 26 个 + 引擎专用 point_tap）
export const STEP_LABELS = {
  // —— 感知（5） ——
  screen: '截图',
  uitree: 'UI树',
  locate: '定位',
  screen_diff: '画面对比',
  read: '读取',
  // —— 操作（9 + 引擎专用） ——
  tap: '点击',
  point_tap: '坐标点击', // 引擎专用（allowCoords 直执行），不进模型工具面但会落 run.json
  long_press: '长按',
  input: '输入',
  swipe: '滑动',
  scroll: '滚动',
  tap_each_row: '逐行点击',
  key: '按键',
  launch: '启动',
  terminate: '强停',
  // —— 环境（6） ——
  net_profile: '切网',
  net_status: '网络状态',
  wait_idle: '等稳定',
  wait_element: '等元素',
  assert_no_crash: '崩溃检查',
  ui_dump: '树取证',
  // —— 数据与扩展（6） ——
  data_extract: '提取',
  data_query: '查询',
  data_store: '存储',
  secret_get: '凭据读取',
  sms_read: '短信读取',
  test_account: '测试账号',
  // —— ask.js 直记账步（非工具）：bin/ask.js sleep/net 分支、aiWaitFor 分支与 aiAssert 判定段 ——
  sleep: '等待',
  net: '切网',
  aiWaitFor: '等待',
  aiAssert: '断言判定',
  // —— tap_each_row 逐题取证子步（src/tools/action.js onQuestion） ——
  answer_row: '作答',
  // —— 历史兼容：assert 在旧版本引擎出现过 1 次（全量历史 run.json 实测）；现引擎
  // 断言结果走 run.assertions，不再产生该类型。保留标签让旧报告正常渲染。 ——
  assert: '断言',
};

// 引擎直记账（非工具）的步骤类型——与 ask.js/action.js 的 startStep 字面量对应
export const ENGINE_STEP_TYPES = ['sleep', 'net', 'aiWaitFor', 'aiAssert', 'answer_row'];

// 回放编排的动作类步骤：有 bounds 时走 [静帧, insight, 动作帧(带指针)] 三段编排，
// 无 bounds 走 [转圈, 动作帧]。判断依据是"这个步骤是不是一次设备写动作"，
// 而非展示分类——感知/等待/数据类步骤只渲染静帧。
export const REPLAY_ACTION_TYPES = [
  'tap', 'point_tap', 'long_press', 'input', 'swipe', 'scroll',
  'key', 'launch', 'terminate', 'tap_each_row',
];
