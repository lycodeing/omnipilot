# skills/ — 智能体技能源文件（契约 §4 交付位置）

> ⚠️ 发现路径说明（2026-10-27 验证发现）：
> Pi SDK 的技能发现**不扫描项目根的 `skills/` 目录**，实际生效位置是
> `<项目根>/.pi/skills/<技能名>/SKILL.md`（子目录 + SKILL.md 命名，平铺 .md 不生效）。
> 因此本目录文件为**源版本**，修改后必须同步复制到 `.pi/skills/`：
>
> ```bash
> cp skills/android-login.md .pi/skills/android-login/SKILL.md
> cp skills/android-navigation.md .pi/skills/android-navigation/SKILL.md
> ```
>
> 验证方法：`loader.skills` 应包含技能名（见 `docs/VERIFICATION-REPORT.md` 缺陷 #10）。

## 现有技能

- `android-login.md` — 登录用例执行节奏（§19.7：凭据注入 / 短信验证码 / 安全边界）
- `android-navigation.md` — 导航与断言纪律（底栏 Tab 定位陷阱 / 转场等待 / 断言判据 / 列表采样 / terminate 窗口）
