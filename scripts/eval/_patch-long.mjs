// Throwaway: the two "long draft" synthetic entries need to exercise long-input
// behaviour, which the 600-char mining cap clipped. Replace them and delete me.
import { readFileSync, writeFileSync } from 'node:fs'

const path = 'scripts/eval/drafts.json'
const set = JSON.parse(readFileSync(path, 'utf8'))

const longSpec = `我想要给这个插件加一个新的「快速提问」面板，需求大概是这样，你帮我理一下：
1. 在输入框右上角加一个图标按钮，点了之后弹出一个浮层，里面有输入框和发送按钮。
2. 问题发出去之后，要能流式显示答案，一个字一个字出来那种。
3. 答案不能进入主对话，也不能被 agent 当成指令执行。
4. 支持连续追问，最多保留最近 10 轮，超过就丢掉最早的。
5. 浮层要能拖动，能记住位置，下次打开还在原来的地方。
6. 手机上也要能用，宽度自适应，不要出现横向滚动条。
7. 要有快捷键，比如 Ctrl+Shift+B 打开，Esc 关闭。
8. 主题要跟随系统，暗色模式下不要有白底闪一下。
9. 历史记录存在本地，文件夹放哪你定，但不要放在项目目录里。
10. 这一版先不做，等我把上面的问题都确认了再说。
另外顺便看一下现在这个功能的性能怎么样，慢的话优化一下，不要引入新的依赖。`

const longDump = `梳理一下这次要改的东西，我先把乱七八糟的都贴在这里，你自己看着办：
- 昨天说的那个通知，一个对话结束发两遍，而且两遍内容都写「没有摘要」，这个必须修，优先修。
- 会话标题有时候会变成一大段话，明显是模型把整段回复塞进去了，要截断，截断规则你定，但不要把一个词砍一半。
- 压缩阈值那个设置，配置文件的键名和界面上的名字对不上，我之前删了又冒出来了，怀疑是旧的键没被清掉，帮我查一下到底是谁在读它。
- 顺便把 README 精简一下，现在太长了，历史改进的内容另外放一个文档。注意：历史内容不要改，只是搬家。
- 我有几个插件的提示词想对比一下效果，你评估一下要不要做一个脚本，能跑三个版本打分的那种，能离线跑更好。
- 界面上的英文字段名统一一下，有的地方是 model，有的地方是 modelId，看着很乱。
- 还有一件事，别动我的 DSH profile，也别重启 dsh web，上次重启之后我的会话列表乱了。
- 另外我希望这个功能不要加太多开关，我上一个插件就是开关太多最后自己都记不住哪个是干嘛的。
- 最后，如果上面有些事情互相冲突（比如既不要动配置又要改键名），你按「先保证现有行为不坏」来定，不要自己拍脑袋。
- 对了，还有性能，之前那个改写有时候要等十几秒，能不能快一点，但不要降质量。`

for (const draft of set.drafts) {
  if (draft.id === 'syn-04') {
    draft.shape = 'long detailed spec (>800 chars)'
    draft.text = longSpec
  }
  if (draft.id === 'syn-08') {
    draft.shape = 'very long messy requirements dump (>2000 chars)'
    draft.text = longDump
  }
}
writeFileSync(path, `${JSON.stringify(set, null, 2)}\n`, 'utf8')
console.log('patched:', set.drafts.filter((d) => d.id === 'syn-04' || d.id === 'syn-08').map((d) => `${d.id} ${d.text.length} chars`).join(', '))
