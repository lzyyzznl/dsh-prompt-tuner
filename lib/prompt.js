/**
 * The optimization contract: the default optimization prompt (the system
 * prompt handed to the chosen model), the per-style directives appended to it,
 * the delimited payload the draft travels in, the output normalizer, and the
 * template the "let the session's own agent rewrite it" route injects.
 *
 * The default prompt is the plugin's own prompt-engineering opinion and is
 * fully user-overridable (the UI writes the override into the config file).
 * It is written as executable instructions to the model, not as advice about
 * prompting.
 *
 * @module dsh-prompt-optimizer/prompt
 */

/** Maximum draft length accepted for one optimization (characters). */
export const MAX_DRAFT_CHARS = 12_000

/** Maximum accepted length of a custom optimization prompt (characters). */
export const MAX_SYSTEM_PROMPT_CHARS = 20_000

/**
 * Default optimization prompt.
 *
 * Calibrated against `../prompt-engineering-research.md` §4 (20 rewrite rules +
 * 10 prohibitions + 5 pre-output self-checks, itself distilled from Anthropic
 * prompting guidance, the OpenAI GPT-5 prompting guide, Codex task anatomy and
 * spec-driven-development practice). Order: fidelity → missing fields →
 * contradictions and over-specification → size → the output contract last,
 * because the output contract is what models drift from first.
 *
 * The last section is a machine-readable one: assumptions and open questions go
 * under a single trailing `## 待确认` heading, which the UI lifts out for display
 * beside the rewrite. It is deliberately *not* stripped from the prompt body —
 * the section stays in the text that reaches the composer, so nothing the model
 * flagged can be lost when the answer is applied automatically.
 */
export const DEFAULT_SYSTEM_PROMPT = `你的职责：把用户给出的「原始任务提示词」改写为一条指向明确、可直接执行的提示词。你不回答任务本身，只产出更好的提示词。凡是会改变任务意图的改写，都以提示词末尾的「待确认」小节保留，绝不替用户做决定。

# 保真（最高优先级）
1. 逐字保留用户的专有名词、文件路径、命令、接口名、术语、变量名与语言；不要"顺手规范化"。
2. 只补全，不扩写：不新增功能、重构、测试框架、日志系统等用户未要求的内容。
3. 原文已有的约束与偏好全部保留，即使你认为多余；删除用户的显式要求属于越权。
4. 信息缺失时不要停下来向用户提问：按最保守的合理假设继续，并把该假设逐条写进末尾的「待确认」小节，最多 3 条、每条一行。任何情况下都不编造事实、数值、路径或接口名。

# 补全字段（缺什么补什么，不要硬塞模板）
5. 先判定任务类型（编码 / 写作 / 调研 / 数据分析 / 配置 / 决策咨询），再选字段；目标写成「把 X 变成 Y」的结果式表述，而不是动作清单。
6. 至少写一条「非目标」（本次明确不做），从"不做未要求的重构 / 不加未要求的功能 / 不为假想需求做设计"中选最相关的一条。
7. 上下文：为什么做、现状如何、已尝试过什么、必须读的输入材料及其路径。
8. 约束：可改范围与禁改范围、技术栈与版本、不得引入的依赖、性能与成本预算。把「要健壮」「注意性能」改写成带条件、阈值或具体动作的句子。
9. 交付物：是什么、放在哪、叫什么名字。
10. 验收标准：3-6 条，每条都能被第三方机械判定"遵守了没有"——给命令、可比字符串、字段存在性、文件路径或明确检查项；禁止「质量高」「写得好」「专业」这类不可判定的表述；必须覆盖边界与失败路径的行为。
11. 输出格式：语言、长度上限、结构（列表 / 表格 / JSON / 正文）、是否需要引用、是否禁止开场白。
12. 失败路径与权限边界：出错时是停止、重试、写日志还是上报；不可逆或对他人可见的动作先确认，并写明"一次授权不等于永久授权"；是否允许联网、装依赖、改配置。

# 消除矛盾与过度指定
13. 把每条指令当孤立规则两两并读，找出互斥对（范围 / 角色 / 格式 / 受众 / 约束五类冲突）；发现冲突**不要删掉一条**，改写成显式优先级：「若 <条件 A>，执行 <指令 A>，并把 <指令 B> 视为仅当 A 不成立时的默认」。
14. 删除无法执行的装饰性指令：「要仔细」「要专业」「think step by step」「don't make mistakes」「你是一位顶尖专家」之类——它们占位置且无机制可执行。
15. 校准自由度与风险：脆弱、必须严格按序的操作（如迁移、发布、不可逆写入）给精确指令与顺序；多路径皆可成功的任务（如评审、调研、方案设计）只给方向与边界，不写死步骤。
16. 只保留"顺序不可交换、或违反后果不可逆"的步骤；其余实现细节交给执行者——目标是规格，不是操作手册。

# 体量（直接决定这次改写是否合格）
17. 最小充分：删掉所有"删了也不改变行为"的句子，不要为了显得完整而变长；原文已足够清晰时只做小幅校正。
18. 长度与任务相称：改写后通常不超过原文的 3 倍；原文不足 200 字时，目标控制在 600 字以内，不要把它撑成一份规格文档。
19. 只写适用的字段：上面第 5-12 条中任务用不到的小节整节省略——不要留空标题，不要写「无」「不适用」「待补充」，也不要逐条复述原文已有的句子。
20. 需要示例时给 3-5 个简短、多样、带标签的示例，用于固定格式或消除歧义；不要罗列边界情况清单。

# 禁止
- 禁止发明用户没给的业务事实、领域规则、数值阈值、API 名称或文件路径。
- 禁止扩大任务范围（加功能、加重构、加测试、加日志），除非用户明确要求。
- 禁止把模糊指令原样保留，也禁止用更模糊的词替换它（把「快」改成「高效」）。
- 禁止用否定句做唯一约束而不给替代动作（「不要用省略号」→「因为会被朗读，改用句号断句」）。
- 禁止在提示词之外输出前言、解释、总结、道歉或"以下是优化后的提示词"之类标签。
- 禁止把「待确认」写成提问清单或要求用户先回答：它只记录你已按什么假设继续，最多 3 条。
- 禁止改变用户要求的输出语言与术语体系；禁止用代码块把整篇输出包起来（正文内的局部代码块不受此限）。

# 输出
只输出改写后的提示词正文本身（Markdown），首字符即正文；如确有假设或未定项，在正文最后追加一个 \`## 待确认\` 小节（最多 3 条，每条一行，不写"无"），除此之外不输出任何内容。`

/**
 * Per-style directive appended to the optimization prompt. Styles specialize the
 * user's prompt instead of replacing it, and each one only moves the two knobs
 * that matter for this task: how much structure, and how much length.
 *
 * Stored as data with a load-time completeness check (every style in the store's
 * closed list must appear here) so adding one cannot silently produce an
 * un-styled rewrite.
 */
export const STYLE_DIRECTIVES = Object.freeze({
  standard: '',
  slim: `\n\n# 本次档位：精简\n在满足上面全部规则的前提下，取最小可行形态：只保留目标、必要约束与验收标准，其余小节一律省略；改写后应短于原文。`,
  structured: `\n\n# 本次档位：结构化\n把改写结果组织为固定小节：目标 / 上下文 / 约束 / 交付物 / 验收标准 / 输出格式。任务确实用不到的小节整节省略，不要留空标题。`,
  expand: `\n\n# 本次档位：扩写\n原文信息过少而无法执行时，补齐到可执行所需的字段（目标、上下文、约束、交付物、验收标准、输出格式），并显式列出你的假设。仍受第 2 条与第 18 条约束：不新增用户未要求的工作，长度不超过原文 3 倍。`,
})

/**
 * The directive for one style id.
 * @param {string} style - one of the store's `STYLE_CHOICES`.
 * @returns {string} the directive to append (`''` for the standard style).
 */
export function styleDirective(style) {
  return STYLE_DIRECTIVES[style] ?? STYLE_DIRECTIVES.standard
}

/** Heading that carries assumptions and open questions at the end of a rewrite. */
export const ASSUMPTION_HEADING = '## 待确认'

/**
 * Lift the trailing `## 待确认` section out of a rewrite for display.
 *
 * Display only: the caller keeps the section in the text it writes back, so an
 * automatically applied rewrite never loses what the model flagged.
 * @param {string} text - normalized rewrite.
 * @returns {{body: string, assumptions: string|null}} the text with the section removed, and the section's own lines.
 */
export function findAssumptions(text) {
  const source = String(text ?? '')
  const at = source.lastIndexOf(ASSUMPTION_HEADING)
  if (at < 0) return { body: source, assumptions: null }
  const lines = source
    .slice(at + ASSUMPTION_HEADING.length)
    .split('\n')
    .map((line) => line.trim().replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, ''))
    .filter((line) => line !== '' && !line.startsWith('#'))
  if (lines.length === 0) return { body: source, assumptions: null }
  return { body: source.slice(0, at).trimEnd(), assumptions: lines.join('\n') }
}

/**
 * The delimiter the draft travels in. Bracketed, unlikely in real drafts, and
 * named so the model can quote it back when the payload is malformed.
 */
const OPEN_TAG = '<<<待优化提示词>>>'
const CLOSE_TAG = '<<<待优化提示词结束>>>'

/**
 * Build the user turn that carries the draft.
 * @param {string} draft - the composer draft verbatim.
 * @returns {string} the delimited payload.
 */
export function buildPayload(draft) {
  return `${OPEN_TAG}\n${draft}\n${CLOSE_TAG}`
}

/**
 * The template the `agent` route writes into the composer instead of calling a
 * model: the session's own agent already holds the full conversation, so it is
 * the better rewriter — and this route costs no model call of its own.
 *
 * The draft is spliced in by concatenation, never as a `String.replace` pattern,
 * so a draft containing `$&` or `$1` cannot corrupt the template.
 */
export const AGENT_TEMPLATE_PLACEHOLDER = '<<<DRAFT>>>'

/**
 * The polish template the `agent` route writes into the composer, with the
 * draft's position marked. Exported so the browser half can splice a draft in
 * without holding a second copy of the wording.
 */
export const AGENT_TEMPLATE = `请把下面这段任务描述改写为一条更明确、可直接执行的提示词，然后把它作为你这一步的唯一交付物输出。

要求：保留我的原意与我写下的专有名词、路径、命令；不要替我扩大任务范围；缺信息时按最保守的假设继续，并把假设列在末尾的「待确认」小节（最多 3 条）。只输出改写后的提示词正文。

${AGENT_TEMPLATE_PLACEHOLDER}`

/** Load-time check: the template must carry exactly one draft placeholder. */
const templateParts = AGENT_TEMPLATE.split(AGENT_TEMPLATE_PLACEHOLDER)
if (templateParts.length !== 2) {
  throw new Error('prompt: the agent template must contain exactly one draft placeholder')
}

/**
 * Splice one draft into the agent-route template.
 * @param {string} draft - the composer draft verbatim.
 * @returns {string} the text that replaces the draft.
 */
export function buildAgentTemplate(draft) {
  return `${templateParts[0]}${draft}${templateParts[1]}`
}

/**
 * Normalize one raw model answer into the text that replaces the draft:
 * trims outer whitespace and unwraps a single code fence that encloses the
 * whole answer (models sometimes return the prompt as a fenced block).
 * @param {string} raw - accumulated text deltas.
 * @returns {string} the replacement text ('' when the answer is empty).
 */
export function normalizeAnswer(raw) {
  let text = String(raw ?? '').replace(/\r\n/g, '\n').trim()
  const fenced = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/.exec(text)
  if (fenced !== null) text = fenced[1].trim()
  return text
}
