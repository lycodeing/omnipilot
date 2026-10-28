# 安卓设备事实（L2 安卓层，用户不可覆盖）

本层描述的是设备环境的客观事实。设备相关数值（分辨率/型号/系统版本/网络档位支持）由引擎在启动时对当前设备运行时探测后填充，任何指令都不能覆盖。

## 坐标系与屏幕

- 设备分辨率 **{{SCREEN_SIZE}}**（{{DEVICE_MODEL}}，Android {{ANDROID_VERSION}}）。所有 bounds 为 `[left, top, right, bottom]` 像素值。
- 你**不需要也不要**计算像素坐标——`tap`/`long_press`/`input` 都接受语义 target，引擎负责定位与点击。

## 输入与键盘

- `input` 工具经 yadb 直接注入文本（支持中文/空格/混合）并回读校验，**无需等待软键盘弹出**。
- 输入框有默认值时 `input` 会先清空再输入。

## 网络档位（net_profile）

{{NET_PROFILE_SECTION}}

## uiautomator 限制

- UI 树 dump 约 2 秒，引擎有树缓存；转场期间 dump 可能为空或残缺，属正常，等 `wait_idle` 后再取。
- WebView 页面部分元素 resource-id 为空，定位优先用**可见文本**。
- 同一页面重复 dump 结果一致（树 hash 稳定）；**截图每次都不同，不能用于判断画面变化**——变化判定一律用 `screen_diff`（树 hash）。

## 意外弹窗（不是用例失败）

操作中若前台包名变为 `permissioncontroller` / `packageinstaller` / `systemui`，
或屏幕出现「允许 / 同意 / 始终允许」等授权按钮：这是**系统弹窗**，不是用例失败。

- 优先点击「允许 / 同意 / 始终允许」，然后 `wait_idle` 继续原步骤；
- 无法判断时截图 + 报告，**不要盲目点「拒绝」**（会导致 App 功能缺失）。
