// 时间线步骤 → 图标类别（StepItem.vue 的纯数据部分）。
//
// 从 .vue 组件抽出为独立 .js：让 Node 测试可直接 import，守护"键集 ⊆ 词表"关系。
// 词表单一来源 src/tools/vocab.js 的 STEP_LABELS；未收录类型落 default 圆点，不猜形状。
// 历史遗留名 screenshot/extract/query/waitFor/back/home 实测 0 次出现，不再收录；
// assert 出现过 1 次保留。

export const ICON_CATEGORY = {
  // 写动作
  tap: 'tap',
  point_tap: 'tap',
  long_press: 'tap',
  input: 'input',
  swipe: 'swipe',
  scroll: 'swipe',
  tap_each_row: 'pen',
  answer_row: 'pen',
  key: 'nav',
  launch: 'nav',
  terminate: 'nav',
  // 感知/等待
  screen: 'camera',
  screen_diff: 'crosshair',
  locate: 'crosshair',
  uitree: 'crosshair',
  ui_dump: 'crosshair',
  sleep: 'clock',
  aiWaitFor: 'clock',
  wait_idle: 'clock',
  wait_element: 'clock',
  // 断言判定（ask.js 直记账步）：与历史 assert 同款图标
  aiAssert: 'assert',
  // 数据/状态
  read: 'extract',
  data_extract: 'extract',
  data_query: 'extract',
  data_store: 'extract',
  secret_get: 'extract',
  sms_read: 'extract',
  test_account: 'extract',
  net: 'extract',
  net_profile: 'extract',
  net_status: 'extract',
  // 历史兼容
  assert: 'assert',
}
