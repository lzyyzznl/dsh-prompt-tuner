# DSH 插件优化集合（dsh-prompt-tuner）

一个个人向的 DSH Web 插件集合：把日常真正用得上的优化做进输入框旁边，而不是只做一件事。目前六件：

- **✨ 提示词改写（单一模式）**：把输入框里**已经写好但还不够明确**的内容，用**一套内置默认提示词**（或你自己写的那一份）改写为指向清楚、更有逻辑、可直接执行的提示词，再交给 agent；可把**最近 n 条会话消息**按时间正序一起拼进提示词，并可选**改写结果用中文还是英文**（见[历史改进记录 · 提示词改写](docs/HISTORY.md#提示词改写单一模式)与[内置提示词的重写与输出语言](docs/HISTORY.md#内置提示词的重写与输出语言2026-10-10)）。
- **💬 旁路提问（`/btw`）**：主任务跑着的时候，顺手问一个小问题——答案只浮在输入框上方，不写进主对话、不打断 agent（见[历史改进记录 · 旁路提问](docs/HISTORY.md#旁路提问btw)）。
- **🗜 上下文压缩阈值**：给**每个模型**单独设一条**固定 token 数**的压缩线（不是百分比），插件把它换算成 DSH 的 `compaction-basic` 需要的窗口占比并**写进 DSH 配置**（见[历史改进记录 · 上下文压缩阈值](docs/HISTORY.md#上下文压缩阈值)）。
- **🔔 任务完成通知**：每个对话任务结束时弹一条**系统桌面通知**，标题取会话标题，正文**先由你指定的模型把本轮回答压缩成一句能完整显示的话**（这次调用固定关闭思考，也绝不把最后一条消息原样推出去）——压不进设置的长度才以 `...` 结尾；宿主按平台分发——Linux 用 `notify-send`、Windows 用 PowerShell 通知、WSL 走 Windows（见[历史改进记录 · 任务完成通知](docs/HISTORY.md#任务完成通知)）。
- **🏷 会话标题重总结**：初始标题仍是会话的**第一句话**（DSH 自己写的，插件不动）；此后每积累 **N 条**你的消息，用**你指定的模型**根据**最近 N 条消息**重写一次标题，长度上限与 N 都在设置页里调（见[历史改进记录 · 会话标题](docs/HISTORY.md#会话标题)）。
- **🛣 供应商熔断与顺序切换**：某个供应商**任何**失败（不再只认 429）都先在原路由上重试 N 次，用完即**熔断**，并按设置页里的**顺序表**切到下一个可用供应商（不必等原供应商的退避）；**冷却时长随连续熔断次数递增**，成功一次归零；到期后按所选方式恢复——默认 **probe：先放行一次探测请求，成功才真正切回**，也可选 `immediate` 时间到就切回。顺序表、重试次数、阈值、冷却与递增倍数都在「路由」页签里改，实时熔断状态也在那里看（见[历史改进记录 · 供应商熔断与顺序切换](docs/HISTORY.md#供应商熔断与顺序切换)）。

所有模型调用都在宿主进程里发生：浏览器不接触凭据，也不直接调用任何 provider；桌面通知同样由宿主按平台派发；熔断状态也只活在宿主进程内存里（不落盘、不写会话）。

> 包名、路由前缀（`/dsh-prompt-optimizer/*`）、设置与旁路历史文件名、`dspo-` 类名前缀等**标识符保持不变**：它们是已装实例与用户设置的引用点，改名会丢配置或需要重装，不属于定位更名。

![seats](https://img.shields.io/badge/seats-composer%20%2B%20dock%20%2B%20overlay%20%2B%20settings-blue)

## 入口

插件占四个座位（五个注册入口），没有自己的面板（集合里的每个功能各占一格）：

| 座位 | 内容 |
| --- | --- |
| `conversation.input.left` | 工具行里的 **✨ 优化提示词** 按钮与一行状态（Alt+O 等价）；同排的 **💬 旁路提问** 按钮（Alt+B、斜杠命令 `/btw` 等价）。 |
| `conversation.input.dock` | **改写预览卡片**：原文与结果并排、模型标注的待确认、采用/撤销/再改一次/关闭。 |
| `conversation.input.overlay` | **旁路提问浮层**（刻意不是模态框，主对话仍在后面继续跑）与一个**不可见的完成通知座位**。 |
| `settings.section` | **「插件优化集合」设置页**（6 个页签）。 |

界面示意（浮层与卡片的实际样子）见[历史改进记录 · 界面](docs/HISTORY.md#界面)。

## 设置

设置页按功能模块分成 **6 个页签**：**优化提示词 / 旁路提问 / 标题 / 压缩 / 通知 / 路由**。**改写功能只占「优化提示词」一个页签**：它没有任何模式开关，页签里只有该功能真正暴露的三项（自定义提示词 + 改写结果的语言 + 携带最近会话消息），外加一行固定事实（模型跟随当前会话、思考固定关闭）。另外五个页签分别是旁路提问、标题、压缩、通知与供应商路由的设置。

配置文件：`$DSH_HOME/prompt-optimizer.json`（默认 `~/.dsh/prompt-optimizer.json`），设置页底部显示实际路径。

```json
{
  "systemPrompt": null,
  "outputLang": null,
  "recentMessages": 8,
  "btwContextTurns": "all",
  "btwSaveHistory": true,
  "btwProvider": null,
  "btwModel": null,
  "btwReasoningEffort": "off",
  "compactionTokens": {},
  "notifyOnComplete": true,
  "notifyMaxChars": 120,
  "titleProvider": null,
  "titleModel": null,
  "titleReasoningEffort": "off",
  "titleRerollTurns": 100,
  "titleMaxChars": 24,
  "routerEnabled": true,
  "routerOrder": [],
  "routerRetries": 3,
  "routerFailureThreshold": 1,
  "routerWindowMs": 60000,
  "routerCooldownMs": 60000,
  "routerCooldownFactor": 2,
  "routerCooldownMaxMs": 1800000,
  "routerRecoveryMode": "probe",
  "routerMaxSwitches": 0,
  "routerLogLevel": "info"
}
```

每个设置项的逐条说明在[历史改进记录 · 设置页](docs/HISTORY.md#设置页)，已移除的旧键如何处理见[历史改进记录 · 配置文件与已移除的旧键](docs/HISTORY.md#配置文件与已移除的旧键)。

## 安装

```sh
dsh plugin add github:lzyyzznl/dsh-prompt-tuner
```

仓库根有 `cordis.patch.yml`（一条 `insert`），`package.json` 声明 `dsh.bundle.patch` 与 `dsh.client.platform=web`；不含构建步骤，`lib/` 即源码。

```sh
npm run check        # 自检（790 项），不需要本机装 DSH
npm run eval:prompt  # 三臂盲评：只打印计划，加 --live / --judge 才发真实请求
npm run eval:attribution  # 归因审计：读已有运行记录，量「改写加了什么用户没提的东西」
```

## 文档

- [历史改进记录](docs/HISTORY.md)：每个功能的设计取舍与固定行为、实测延迟与失败阶梯、与其他同类插件的差异、架构与文件职责、自检覆盖范围，以及全部已知限制。
- [内置提示词的依据与实测](docs/prompt-rationale.md)：默认提示词为什么是这六步、三臂盲评的方法与数字、归因审计（改写里有多少东西是用户没提的）的口径与结果，以及中英两条输出路径的对照与偏差。
- [通知路径的实测记录](docs/notify-testing.md)：Windows toast 派发的实测与推断边界。

## 许可

BSD-3-Clause。
