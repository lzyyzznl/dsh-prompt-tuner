# 测试要点（供接手 agent 参考）

> 主题一：**Windows 桌面通知的端到端投递验证**。
> 这是本仓库唯一一个「失败无声」的功能，所以测试方法与其它模块不同——
> 命令返回成功**不代表**通知出现了。照本文档执行即可判断，无需再问。
>
> 主题二（第六之二节）：**通知正文的模型压缩**——推送的是压出来的一句话，
> 不是助手原文。这一段需要一次真实模型调用，无法用返回码代替。

---

## 一、要测什么

测的是 **toast 有没有真的渲染到屏幕上**，不是「命令有没有报错」。

原因：`CreateToastNotifier().Show()` 对一个**没注册过**的 AppUserModelID（AUMID）
- 正常返回，不抛异常；
- `powershell.exe` 退出码 0；
- Windows 甚至把这条 toast 写进通知历史。

**然后屏幕上什么都没有。** 这是一次真实事故的根因：插件因此长期回报 `sent: true`，
设置页的测试按钮也报成功，而用户一条通知都收不到。

所以：**永远不要用返回码、也不要用 `ok:true` 判断成功。**

---

## 二、两个必须先知道的陷阱

1. **不能用 `pwsh`（PowerShell 7）执行。** PowerShell 7 移除了 WinRT 投影，
   `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]`
   会直接报「找不到类型」。必须用 `powershell.exe`（Windows PowerShell 5.1，Win10/Win11 自带）。
   实测：5.1 通过、7.6.6 失败。
2. **`/notify.test` 返回的 `sent:true` / `ok:true` 在修复前也是真的**——那正是 bug 本身。
   判断成功要看返回里的 **`registration`** 字段（见方法 A）。

---

## 三、怎么测

### 方法 A：跑生产路由（最快，不需要重启 DSH）

对正在运行的宿主发一条测试通知：

```powershell
$base = $env:DSH_WEB_URL        # 例如 http://127.0.0.1:55020
Invoke-RestMethod -Uri "$base/dsh-prompt-optimizer/notify.test" -Method Post `
  -ContentType 'application/json' -Body '{}' -Headers @{ Origin = $base } |
  ConvertTo-Json -Depth 6
```

读返回里的 `registration`：

| `registration` | 含义 | 此时屏幕上 |
| --- | --- | --- |
| `created` | 本次刚把 AUMID 注册上 | 应能看到 toast |
| `present` | 该 id 早就注册过，脚本没重写 | 应能看到 toast |
| `blocked` | 两个注册键都写不进去，返回 `ok:false` 并附原因 | **大概率看不到**（这就是需要处理的情况） |
| 字段不存在 | 跑的是**旧代码**（该字段是后加的） | 无法判断，需先确认版本 |

补充：`/state` 的信封是 `{ ok, value }`，通知契约在 `.value.notify`。

### 方法 B：验证「真的渲染了」的客观判据（重点）

**渲染成功时，Windows 会自己创建并更新时间戳**：

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\<AUMID>
    LastNotificationAddedTime   (REG_BINARY, FILETIME)
```

```powershell
$id = 'ai.deepseek.dsh.desktop'   # 或被测的 AUMID
$p  = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\$id"

$before = if (Test-Path $p) { (Get-ItemProperty $p).LastNotificationAddedTime } else { 0 }
# …在这里发一次通知…
Start-Sleep -Seconds 3
$after  = if (Test-Path $p) { (Get-ItemProperty $p).LastNotificationAddedTime } else { 0 }

"delivered: $($after -ne $before)"                       # True = 确实投递了
if ($after) { [DateTime]::FromFileTime([int64]$after) }  # 投递时刻
```

**这是最有价值的判据。** 修复前的实测对照：同一路由返回 `sent:true`，
但该键**从未被创建**；补上注册后，时间戳立刻开始前进。

也可以用通知历史（注意必须用 5.1 执行）：

```powershell
powershell.exe -NoProfile -Command "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('ai.deepseek.dsh.desktop')).Count"
```

`History.GetHistory(aumid)` **是按 AUMID 过滤的**（拿不存在的 id 查得到 0），
但它对**未注册**的 id 同样会返回条目——
**所以「历史里有记录」不等于「渲染了」**，必须配合上面的 Settings 键一起看。

### 方法 C：在全新 AUMID 上验「自举」，不动用户现有配置

先清干净，再用一个临时 id 跑真实 `sendNotification`：

```powershell
$id = 'dsptest.bootstrap'
Remove-Item "HKCU:\Software\Classes\AppUserModelId\$id" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications\Backup\$id" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\$id" -Recurse -Force -ErrorAction SilentlyContinue
```

```js
// node，工作目录 = 仓库根
import { execFile } from 'node:child_process'
import * as notify from './lib/notify.js'
const run = (c, a, o) => new Promise((r) => execFile(c, a, { timeout: o.timeout, windowsHide: true },
  (e, out) => r({ error: e ?? null, stdout: out ?? '' })))
const out = await notify.sendNotification(
  { title: 'DSH · 测试', body: '自举验证' },
  { platform: 'win32', appId: 'dsptest.bootstrap', displayName: 'DSH', run },
)
console.log(out)   // 期望：ok:true, registration:'created'
```

跑完**务必删掉三个测试键**（上面三条 `Remove-Item` 再执行一遍）；
测试用的 AUMID 会常驻注册表，不要留在用户机器上。

---

## 四、预期结果

| 检查项 | 期望 |
| --- | --- |
| `/notify.test` 返回 | `ok:true`、`platform:"windows"`、`command:"powershell.exe"` |
| 首次用一个全新 AUMID | `registration:"created"`，且两个注册键都被创建 |
| 紧接着再发一次 | `registration:"present"`，且**不重写**已有键 |
| 注册键内容（`Classes\AppUserModelId\<id>`） | `DisplayName`、`IconUri`（仅盘符路径或 UNC）、`ShowInSettings=1` |
| 注册键内容（`PushNotifications\Backup\<id>`） | `appType=app:desktop`、`Setting=s:banner,s:toast,s:audio,c:toast,c:ringing`、`wnsId=NonImmersivePackage` |
| 客观投递判据（方法 B） | `LastNotificationAddedTime` **前进**（或键从无到有） |
| 用 `pwsh` 执行同一脚本 | 失败，报找不到 WinRT 类型（这是**预期**行为，不是 bug） |
| 注册写不进去时 | `registration:"blocked"`、`ok:false`、`error` 里带注册表路径 |
| 用户主观确认 | 屏幕右下角出现 toast（最终判据，前几条都是代理指标） |

上面 `PushNotifications\Backup` 的三个值不是猜的：
它们与 **Windows 自己**为本机已注册应用（`ai.deepseek.dsh.desktop.next`、
`electron.app.DSH NEXT`）写下的值逐字相同。改动这段时请保持对齐。

---

## 五、本机（2026-10-09）无法验证、需要另找环境的部分

| 未验证项 | 怎么补测 |
| --- | --- |
| **Windows 10 上只靠两个注册表键能否渲染** | 找一台 Win10 跑方法 A + 方法 B；本机只有 Win11 26300 |
| 真 WSL 链路（Linux 进程弹 Windows toast） | 在 WSL 里跑方法 C；注意 `process.execPath` 是 POSIX 路径，此时不应写 `IconUri` |
| `dsh web` profile 下的实际派发 | 在 web profile 起会话、跑完一轮，看完成通知是否触发 |
| 受约束语言模式（WDAC/AppLocker） | 开 WDAC 的机器上跑；期望是 `blocked` 而不是崩溃（脚本不用 `Add-Type`、`Import-Module`、不碰 `HKLM:`） |
| 宿主以服务 / 非交互会话运行 | 无法从脚本侧探测；那种会话本就不显示 toast |

---

## 六、环境快照

- OS：Windows 11 专业版 `10.0.26300`
- `powershell.exe`：`5.1.26100.9549`（**toast 只能用它**）
- `pwsh`：`7.6.6`（**不可用于 toast**）
- 宿主地址：`$env:DSH_WEB_URL`（本次为 `http://127.0.0.1:55020`），profile `desktop`
- 本机已注册的 DSH 相关 AUMID（开始菜单快捷方式）：
  `ai.deepseek.dsh.desktop.next`、`electron.app.DSH NEXT`
- 插件自己使用并注册的 AUMID：`ai.deepseek.dsh.desktop`

### 一个容易踩的认知陷阱

**安装器注册 AUMID 用的是开始菜单*快捷方式*，它不会写 `Classes\AppUserModelId` 键。**
实测：`.next` 与 `electron.app.DSH NEXT` 在该路径下都没有键。
所以「这个键不存在」不能推出「这个 AUMID 没注册」——
它只说明*本插件*没写过。判断注册状态时要注意这个盲区。

---

## 六之二、正文压缩（2026-10-09 新增）怎么验

通知正文不再原样推送，而是先由模型压成一句不超过上限的话。这一段**没有**独立按钮，
因为它需要一次真实的模型调用：

| 检查项 | 期望 |
| --- | --- |
| 跑完一轮真实回答后的宿主日志 | `[prompt-optimizer] notification shown (N title / M body chars, summary from provider/model in K attempt(s))`；`M <= notifyMaxChars` |
| 日志末尾有没有 `, cut to fit` | 有 = 这一次仍然切过（两次都没压进上限）；正常应当是**没有** |
| 桌面上那条 toast 的结尾 | 正常**没有** `...`（说明是模型按上限写的，不是被切出来的） |
| 压缩失败时的日志 | `[prompt-optimizer] notification summary failed (code): message`，桌面正文是「本轮已结束，摘要不可用」——**不是**回答原文 |
| 浏览器控制台 | `[prompt-tuner] session … notification body condensed to N chars in K attempt(s)` 或 `… has no summary (code)` |
| `/notify` 的返回（可自己发一次） | `value.summary = { requested, ok, code, attempts, model, reasoningEffort, chars, truncated }`；`reasoningEffort` 必须是 `off`，`attempts` 是 1 或 2，`truncated` 为 `true` 时 `chars == notifyMaxChars` |
| `/state` 的通知契约 | `value.notify.thinking === 'off'`（设置页据此决定是否显示「摘要模型」那一行）、`active` 是这次真要用的路由 |
| 设置页「通知 → 摘要模型」 | 选了之后 `/state` 的 `notify.active` 跟着变；清掉两个键就回落成跟随会话模型 |

手工发一次 `/notify`（会真的弹 toast，也会真的调一次模型）：

```powershell
$base = $env:DSH_WEB_URL
Invoke-RestMethod -Uri "$base/dsh-prompt-optimizer/notify" -Method Post `
  -ContentType 'application/json' -Headers @{ Origin = $base } `
  -Body '{"title":"压缩验证","body":"这是一段刻意写得很长的回答……（换成几千字，看压出来的结果）","needsSummary":true}' |
  ConvertTo-Json -Depth 6
```

`needsSummary:false` 是另一条路径：浏览器已经判定「本轮没有回答」，宿主**不调模型**、
原样派发那句话。想验「不调模型」就把它设为 `false`，此时 `summary.code` 应为 `no-answer`。

契约本身（关闭思考、上限进提示词、超长再压一次、两次都超长才 `truncated`、失败不退回原文、
无原文不调模型）由 `scripts/check.mjs` 用**脚本化假适配器**覆盖；「某个具体模型是否一次就压到
120 字以内」只能真机量，本机已实测一次：

| 日期 | 环境 | 输入 | 结果 |
| --- | --- | --- | --- |
| 2026-10-09 | 重装后的 desktop profile，`deepseek-account/deepseek-flash` | 240 字中文正文，`notifyMaxChars=120` | `sent:true`、`registration:"present"`、`attempts:1`、`reasoningEffort:"off"`、`truncated:false`，压成 35 字，桌面正文结尾**没有** `...` |

这一次只说明「这个模型、这类回答一次到位」；换模型、换很长的回答仍可能走第二次调用，
或落到 `truncated:true`，按上面的表读日志即可判断。

---

## 七、相关代码位置

- 派发与自举：`lib/notify.js` — `windowsToastScript()`（生成注册+投递脚本）、
  `parseAppIdState()`（读回 `created|present|blocked`）、`sendNotification()`（汇总结果）
- 正文压缩：`lib/notify-summary.js` — 两段提示词、输入组帧、回答清洗、上限判定与兜底裁剪；
  调用与重试在 `lib/routes.js` — `askNotifySummary()`（固定 `pickEffort('off', …)`），
  路由拼装在 `lib/routes.js` — `case '/notify'`
- 路由：`lib/routes.js` — `/notify`、`/notify.test`
- 自检：`scripts/check.mjs` — 搜 `AUMID` / `IconUri` / `parseAppIdState`；
  压缩契约搜 `摘要` / `askNotifySummary` / `NOTIFY_SUMMARY_FALLBACK_BODY`
  （这些断言是纯静态/纯伪 runner，**不会**真的弹通知、也不会真的调模型，不能替代上面的真机验证）
