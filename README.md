# DSH 插件优化集合（dsh-prompt-tuner）

一个个人向的 DSH Web 插件集合：把日常真正用得上的优化做进输入框旁边，而不是只做一件事。目前四件：

- **✨ 提示词改写（单一模式）**：把输入框里**已经写好但还不够明确**的内容，用**一套内置默认提示词**（或你自己写的那一份）改写为指向清楚、更有逻辑、可直接执行的提示词，再交给 agent；可把**最近 n 条会话消息**按时间正序一起拼进提示词，可选**改写结果用中文还是英文**，并可指定**用哪个模型、思考到什么档位**（默认跟随当前会话、不思考）。改写输出期间**输入框里的发送被禁用**（打字不受影响），结果落进输入框那一刻起才放开（见[历史改进记录 · 提示词改写](docs/HISTORY.md#提示词改写单一模式)、[优化期间锁住发送](docs/HISTORY.md#优化期间锁住发送2026-10-11)与[改写自己的模型与强度](docs/HISTORY.md#改写自己的模型与强度2026-10-10)）。
- **💬 旁路提问（`/btw`）**：主任务跑着的时候，顺手问一个小问题——答案只浮在输入框上方，不写进主对话、不打断 agent（见[历史改进记录 · 旁路提问](docs/HISTORY.md#旁路提问btw)）。
- **🔔 任务完成通知**：每个对话任务结束时弹一条**系统桌面通知**，标题取会话标题，正文**先由你指定的模型把本轮回答压缩成一句能完整显示的话**（这次调用的思考强度可配，默认关闭；也绝不把最后一条消息原样推出去）——压不进设置的长度才以 `...` 结尾；宿主按平台分发——Linux 用 `notify-send`、Windows 用 PowerShell 通知、WSL 走 Windows（见[历史改进记录 · 任务完成通知](docs/HISTORY.md#任务完成通知)）。
- **🏷 会话标题重总结**：初始标题仍是会话的**第一句话**（DSH 自己写的，插件不动）；此后每积累 **N 轮次**（`user/message` 事件——你的消息与系统注入的上下文都算推进），用**你指定的模型**根据**最近的人类消息**重写一次标题（长度上限与 N 都在设置页里调）。**计数按历史会话长度，重启不会清零**——长会话在启动时就会按历史长度补一次重总结；composer 工具行还有一个「重建标题」按钮，随时可以跳过轮数**立刻**重写，成功与失败都会写进会话日志留痕（见[历史改进记录 · 会话标题](docs/HISTORY.md#会话标题)）。

所有模型调用都在宿主进程里发生：浏览器不接触凭据，也不直接调用任何 provider；桌面通知同样由宿主按平台派发。

> 包名、路由前缀（`/dsh-prompt-optimizer/*`）、设置与旁路历史文件名、`dspo-` 类名前缀等**标识符保持不变**：它们是已装实例与用户设置的引用点，改名会丢配置或需要重装，不属于定位更名。

![seats](https://img.shields.io/badge/seats-composer%20%2B%20dock%20%2B%20overlay%20%2B%20settings-blue)

## 入口

插件占四个座位（五个注册入口），没有自己的面板（集合里的每个功能各占一格）：

| 座位 | 内容 |
| --- | --- |
| `conversation.input.left` | 工具行里的 **✨ 优化提示词** 按钮与一行状态（Alt+O 等价）；同排的 **💬 旁路提问** 按钮（Alt+B、斜杠命令 `/btw` 等价）。改写输出期间它还会把**输入框自己的发送按钮**握在关闭状态（编辑器照常可打字），见[优化期间锁住发送](docs/HISTORY.md#优化期间锁住发送2026-10-11)。 |
| `conversation.input.dock` | **改写预览卡片**：原文与结果并排、模型标注的待确认、采用/撤销/再改一次/关闭。 |
| `conversation.input.overlay` | **旁路提问浮层**（刻意不是模态框，主对话仍在后面继续跑）与一个**不可见的完成通知座位**。 |
| `settings.section` | **「插件优化集合」设置页**（4 个页签）。 |

界面示意（浮层与卡片的实际样子）见[历史改进记录 · 界面](docs/HISTORY.md#界面)。

## 设置

设置页按功能模块分成 **4 个页签**：**优化提示词 / 旁路提问 / 标题 / 通知**。**改写功能只占「优化提示词」一个页签**：它没有任何模式开关，页签里只有该功能真正暴露的五项（优化用的模型 + 改写的思考强度 + 自定义提示词 + 改写结果的语言 + 携带最近会话消息）；模型默认「跟随当前会话」、强度默认 `off`，不填就是零配置行为。**四个用到模型的功能（改写 / 旁路提问 / 标题 / 通知）都各自可选模型并各自可选思考档位**，互不影响。

配置文件：`$DSH_HOME/prompt-optimizer.json`（默认 `~/.dsh/prompt-optimizer.json`），设置页底部显示实际路径。

```json
{
  "systemPrompt": null,
  "recentMessages": 8,
  "outputLang": null,
  "provider": null,
  "model": null,
  "reasoningEffort": "off",
  "btwContextTurns": "all",
  "btwContextCount": 8,
  "btwSaveHistory": true,
  "btwProvider": null,
  "btwModel": null,
  "btwReasoningEffort": "off",
  "notifyOnComplete": true,
  "notifyMaxChars": 120,
  "notifyProvider": null,
  "notifyModel": null,
  "notifyReasoningEffort": "off",
  "titleProvider": null,
  "titleModel": null,
  "titleReasoningEffort": "off",
  "titleRerollTurns": 100,
  "titleMaxChars": 24
}
```

每个设置项的逐条说明在[历史改进记录 · 设置页](docs/HISTORY.md#设置页)，已移除的旧键如何处理见[历史改进记录 · 配置文件与已移除的旧键](docs/HISTORY.md#配置文件与已移除的旧键)。

**思考档位发到网关上是什么**：插件自己只声明标准的 `reasoningEffort`，不发任何网关私有字段。

## 安装

```sh
dsh plugin add github:lzyyzznl/dsh-prompt-tuner
```

仓库根有 `cordis.patch.yml`（一条 `insert`），`package.json` 声明 `dsh.bundle.patch` 与 `dsh.client.platform=web`；不含构建步骤，`lib/` 即源码。

```sh
npm run check        # 自检（648 项），不需要本机装 DSH
npm run eval:prompt  # 三臂盲评：只打印计划，加 --live / --judge 才发真实请求
npm run eval:attribution  # 归因审计：读已有运行记录，量「改写加了什么用户没提的东西」
```

## 文档

- [历史改进记录](docs/HISTORY.md)：每个功能的设计取舍与固定行为、实测延迟与失败阶梯、与其他同类插件的差异、架构与文件职责、自检覆盖范围，以及全部已知限制。
- [内置提示词的依据与实测](docs/prompt-rationale.md)：默认提示词为什么是这六步、三臂盲评的方法与数字、归因审计（改写里有多少东西是用户没提的）的口径与结果，以及中英两条输出路径的对照与偏差。
- [通知路径的实测记录](docs/notify-testing.md)：Windows toast 派发的实测与推断边界。

## 许可

BSD-3-Clause。
