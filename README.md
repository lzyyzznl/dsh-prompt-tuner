# DSH 插件优化集合（dsh-prompt-tuner）

一个个人向的 DSH Web 插件集合：把日常真正用得上的优化做进输入框旁边，而不是只做一件事。目前六件：

- **✨ 提示词改写（单一模式）**：把输入框里**已经写好但还不够明确**的内容，用**一套内置默认提示词**（或你自己写的那一份）改写为指向清楚、更有逻辑、可直接执行的提示词，再交给 agent；可把**最近 n 条会话消息**按时间正序一起拼进提示词，可选**改写结果用中文还是英文**，并可指定**用哪个模型、思考到什么档位**（默认跟随当前会话、不思考）（见[历史改进记录 · 提示词改写](docs/HISTORY.md#提示词改写单一模式)与[改写自己的模型与强度](docs/HISTORY.md#改写自己的模型与强度2026-10-10)）。
- **💬 旁路提问（`/btw`）**：主任务跑着的时候，顺手问一个小问题——答案只浮在输入框上方，不写进主对话、不打断 agent（见[历史改进记录 · 旁路提问](docs/HISTORY.md#旁路提问btw)）。
- **🗜 上下文压缩阈值**：给**每个模型**单独设一条**固定 token 数**的压缩线（不是百分比），插件把它换算成 DSH 的 `compaction-basic` 需要的窗口占比并**写进 DSH 配置**（见[历史改进记录 · 上下文压缩阈值](docs/HISTORY.md#上下文压缩阈值)）。
- **🔔 任务完成通知**：每个对话任务结束时弹一条**系统桌面通知**，标题取会话标题，正文**先由你指定的模型把本轮回答压缩成一句能完整显示的话**（这次调用的思考强度可配，默认关闭；也绝不把最后一条消息原样推出去）——压不进设置的长度才以 `...` 结尾；宿主按平台分发——Linux 用 `notify-send`、Windows 用 PowerShell 通知、WSL 走 Windows（见[历史改进记录 · 任务完成通知](docs/HISTORY.md#任务完成通知)）。
- **🏷 会话标题重总结**：初始标题仍是会话的**第一句话**（DSH 自己写的，插件不动）；此后每积累 **N 条**你的消息，用**你指定的模型**根据**最近 N 条消息**重写一次标题，长度上限与 N 都在设置页里调（见[历史改进记录 · 会话标题](docs/HISTORY.md#会话标题)）。
- **🛣 供应商熔断与顺序切换（已拆成本地独立服务）**：某个供应商**任何**失败都在原路由上重试 N 次，用完即**熔断**，按**顺序表**切到下一个可用供应商（不必等原供应商的退避）；**冷却时长随连续熔断次数递增**，成功一次归零；到期后按所选方式恢复——默认 **probe：先放行一次探测请求，成功才真正切回**，也可选 `immediate`。这一半**不再跑在插件里**：插件只负责把它作为独立进程拉起来，顺序表、供应商与密钥、熔断参数都在**服务自己的页面**上改，插件设置页的「路由」页签变成只读状态 + 跳转链接。服务对外是一个 **OpenAI 兼容的本地代理**（默认 `http://127.0.0.1:8790/v1`），所以**本机任何 agent 都能用**，不限于 DSH。它还带一个可注册的**协议转换器**接口，内置的 `maas` 转换器把 ZTE 网关那两个模型（`maas-dsv4/deepseek-v4-flash`、`maas-coclaw/co-claw`）的出入参对齐到 `api.deepseek.com` 的契约（见[路由服务](#路由服务独立进程)与[历史改进记录 · 路由服务与 maas 转换器](docs/HISTORY.md#路由服务与-maas-转换器2026-10-10)）。

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

设置页按功能模块分成 **6 个页签**：**优化提示词 / 旁路提问 / 标题 / 压缩 / 通知 / 路由**。**改写功能只占「优化提示词」一个页签**：它没有任何模式开关，页签里只有该功能真正暴露的五项（优化用的模型 + 改写的思考强度 + 自定义提示词 + 改写结果的语言 + 携带最近会话消息）；模型默认「跟随当前会话」、强度默认 `off`，不填就是零配置行为。**四个用到模型的功能（改写 / 旁路提问 / 标题 / 通知）都各自可选模型并各自可选思考档位**，互不影响；固定了改写模型后，改写也不再走「路由」页签的熔断切换（那条链路只接管会话自己的模型调用）。另外五个页签分别是旁路提问、标题、压缩、通知与路由的设置。**「路由」页签不再编辑任何东西**：配置与熔断状态都在独立服务里，这个页签只显示服务的地址、存活状态、实时的熔断表与最近的切换记录，并提供跳转到服务自身页面的入口——两处都能改同一份配置就会漂移，所以这里只读。

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
  "compactionTokens": {},
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

**思考档位发到网关上是什么**：插件自己只声明标准的 `reasoningEffort`，不发任何网关私有字段（profile 里那两条 MaaS 路由的 `reasoningEfforts` 仍然有效）。而经过路由服务的调用，转换器会进一步把入参**按参照契约**翻译：`thinking: {type: 'disabled'}` 落成 `reasoning_effort: "none"`，`thinking: {type:'enabled', budget_tokens}` 落成就近的档位，`max_completion_tokens` 折成 `max_tokens`，`response_format: json_object` 按官方的前置条件校验；出参则把 `reasoning` 改名为 `reasoning_content`、摘掉网关常驻的空字段、补齐 `usage` 与 `system_fingerprint`。判据是**实测**而不是文档，逐条对照见[路由服务](#路由服务独立进程)。

## 路由服务（独立进程）

熔断与路由不再属于插件运行时，而是一个**本地独立服务**：`lib/service/`。插件只做三件事——在插件激活时把它 fork 起来（没在跑的话）、
把设置页的「路由」页签指向它、把三个按钮（探测 / 清空熔断 / 刷新）转达过去。**没有任何熔断状态留在插件进程里**，也没有第二份实现。

### 它对外长什么样

| 面 | 地址 | 说明 |
| --- | --- | --- |
| OpenAI 兼容 | `POST http://127.0.0.1:8790/v1/chat/completions`（`GET /v1/models`） | 把任何 OpenAI 客户端/agent 的 `baseURL` 指过来即可；入参出参按参照契约（见下） |
| 管理页 | `http://127.0.0.1:8790/` | 配置供应商与密钥、顺序表、熔断参数；看实时熔断表、最近切换与统计 |
| 管理 API | `POST/GET http://127.0.0.1:8790/admin/api/{state,config,reset,probe,converters}` | 管理页用的接口，需要 `X-Router-Token`（页面自带，令牌在配置文件里） |
| 存活 | `GET /healthz` | 插件用它判断该接入还是该拉起 |

**只监听 `127.0.0.1`**，不做鉴权面之外的暴露。`/admin/api/*` 需要令牌：一个用户随手打开的网页可以对 `127.0.0.1` 发跨源 POST，
但不该能改路由或读到（掩码的）凭据。`/v1/*` 不需要，因为它只对本机开放，而它持有的凭据本来就已经在这台机器上。

### 接入方式

自己把本地模型地址指过去就行，插件**不会**替你改 profile：

```jsonc
// 以 DSH 的 pi-ai provider 为例（也可以改用任何 OpenAI 客户端）
"local-router": {
  "api": "openai-completions",
  "baseURL": "http://127.0.0.1:8790/v1",
  "models": [{ "id": "deepseek-v4-flash" }]
}
```

北向的 `model` 用来决定**从顺序表哪一行开始试**：写 `deepseek-v4-flash` 从第一个模型名匹配的行开始，写 `maas-dsv4/deepseek-v4-flash`
从那一行开始，都不匹配就从第一行开始；之后按顺序表往后走并**回绕**——顺序表是一个池子加一个偏好，不是单向链表。切换对调用方是**透明**的：
只要上游还没吐出头一个字节，失败的那一跳不会出现在调用方的响应里。

### 转换器

服务提供一个**注册接口**，转换器是**代码模块**（`lib/service/converters/`），在配置里按 id 列出来即可：

```js
defineConverter({ id, label, match, toUpstream, fromUpstream, fromUpstreamChunk, errorBody, listModels })
```

只有 `id`/`label` 是必填，其余缺省都是原样透传——所以「没注册转换器的路由」行为不变。这么设计是因为转换器要改的是**流式 SSE 的增量**、
要合成的 `usage`、要重写的错误体：那是状态机，不是替换表，声明式规则表达不了。内置一个 `maas` 转换器：

| 轴 | 参照契约（`api.deepseek.com`） | ZTE 网关 | 转换器怎么做 |
| --- | --- | --- | --- |
| 思考开关 | `thinking: {type: 'disabled'\|'enabled', budget_tokens}` + `effort` | 忽略 `thinking`；认 `reasoning_effort`（`none` 真的关） | 翻译成 `reasoning_effort`，并把 `thinking`/`effort` 从上游请求里删掉 |
| 输出上限 | `max_tokens`（含思考 token） | 两种都认 | `max_completion_tokens` 折进 `max_tokens` |
| `response_format: json_object` | 提示词里没有 "json" 就 400 | 无条件接受 | **强制**参照契约的前置条件（这是唯一一处比上游更严） |
| 思考正文 | `message.reasoning_content` | `message.reasoning` | 改名 |
| 思考 token 数 | 总是上报 | `co-claw` 上报，`deepseek-v4-flash` 不上报 | 没思考就写 `0`；思考了但上游没报就**省略**，不估算 |
| `model` 回显 | 请求的名字 | 后端名（`DeepSeek-V4-Flash-0731`） | 回显调用方请求的名字 |
| `usage` 细节 | `prompt_cache_hit_tokens` / `miss_tokens` | `prompt_tokens_details.created_cache_tokens` 等 | 归一到参照契约；网关多出来的计数器丢掉 |
| `system_fingerprint` | 有 | 有（`vllm-…`） | 原样透传，没有时按 provider+后端名合成 |
| 错误体 | `{error: {message, type, param, code}}` | vLLM 自己的形状 | 按状态码重写 |
| 未知字段 | — | — | **一律原样透传**，不丢数据 |

转换器**不会自作主张加参数**：调用方什么都没说时不发 `reasoning_effort`，由网关自己的默认值决定（`co-claw` 默认为开、`deepseek-v4-flash` 默认为关）。
它保证的是「显式控制两边同义」。逐条实测见[历史改进记录 · 路由服务与 maas 转换器](docs/HISTORY.md#路由服务与-maas-转换器2026-10-10)。

### 配置与密钥

配置在 `$DSH_HOME/router-service.json`（默认 `~/.dsh/router-service.json`，0600），**由服务的页面读写**。首次运行会从插件的旧设置里
把顺序表搬过来，并预置两条 MaaS 路由的地址——**但不预置任何密钥**，密钥要你自己在页面上填。服务不会去读 DSH 的凭据库。

### 生命周期

服务由插件 fork，**随 DSH 退出而停**。这是刻意的取舍：换来的是零手工步骤。想让它活过 DSH 重启，本机已有现成的约定——
`systemd-run --user --unit=<name> node <插件目录>/lib/service/main.js`（`dsh-remote-gateway` 就是这么做的）；
服务本身不关心是谁拉起它的，插件发现端口上已经有服务在跑时会**接入**而不是再拉起一个。

### 自检

```sh
npm run check:service   # 128 项：桩上游 + 真服务 + 真 socket，离线、零 token
npm run check:live      # 23 项：对真实网关的端到端实测，需网络与密钥，非离线自检
```

覆盖转换器的入参/出参映射、熔断与切换、重试、坏响应、管理面鉴权、配置校验与迁移、转换器注册表、SSE 解析、以及**插件真的能把它拉起来并转达**。
另有 `npm run check:live`：对**真实网关**的端到端实测（23 项，需要网络、需要你自己在凭据库里配好那两个 ref，会花真实 token），所以它**故意不进 `npm run check`**；结论记在历史改进记录里。

## 安装

```sh
dsh plugin add github:lzyyzznl/dsh-prompt-tuner
```

仓库根有 `cordis.patch.yml`（一条 `insert`），`package.json` 声明 `dsh.bundle.patch` 与 `dsh.client.platform=web`；不含构建步骤，`lib/` 即源码。

```sh
npm run check        # 自检（735 项），不需要本机装 DSH
npm run eval:prompt  # 三臂盲评：只打印计划，加 --live / --judge 才发真实请求
npm run eval:attribution  # 归因审计：读已有运行记录，量「改写加了什么用户没提的东西」
```

## 文档

- [历史改进记录](docs/HISTORY.md)：每个功能的设计取舍与固定行为、实测延迟与失败阶梯、与其他同类插件的差异、架构与文件职责、自检覆盖范围，以及全部已知限制。
- [内置提示词的依据与实测](docs/prompt-rationale.md)：默认提示词为什么是这六步、三臂盲评的方法与数字、归因审计（改写里有多少东西是用户没提的）的口径与结果，以及中英两条输出路径的对照与偏差。
- [通知路径的实测记录](docs/notify-testing.md)：Windows toast 派发的实测与推断边界。

## 许可

BSD-3-Clause。
