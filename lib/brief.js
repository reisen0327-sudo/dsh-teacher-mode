/**
 * The learner profile: the welcome form that runs before the first tool call,
 * the persisted per-session record it produces, and the model-facing notice
 * that hands the answers to the tutor.
 *
 * The profile is stored in memory per session and mirrored to a workspace file
 * so a resumed session keeps its goals and materials. The file is best effort:
 * a read-only deployment still teaches, it just re-asks after a restart.
 */

import { randomUUID } from 'node:crypto'
import { briefPath } from './paths.js'
import { GOALS, goalByLabel, normalizeProfile, profileHasContent } from './policy.js'

/** Error codes meaning "no human can be asked here". */
const NO_CHANNEL_CODES = new Set(['NO_PROVIDER', 'EMPTY_QUESTIONS', 'CALLER_NOT_LIVE', 'DELEGATED_CALLER'])

/** Error codes meaning "the learner closed the form without answering". */
const DISMISSED_CODES = new Set(['ASK_CANCELLED'])

/** One-line notice bound: the durable summary is capped at 120 characters. */
function summaryOf(text) {
  return text.length <= 118 ? text : `${text.slice(0, 117)}…`
}

/**
 * Build the welcome form. Questions carry stable ids; labels are the answer
 * values, so the goal question maps labels back to stable ids.
 *
 * @param {any} [existing] A previously recorded profile used to prefill nothing
 *   (the form is text and options only) but to keep goal wording stable.
 * @returns {Array<object>} The question batch for `ctx.userQuestions.ask`.
 */
export function buildWelcomeQuestions(existing) {
  const goalOptions = GOALS.map(goal => ({ label: goal.label, description: goal.description }))
  const questions = [
    {
      id: 'topic',
      header: '学习内容',
      question: '这次想学什么？（课程、科目或技术主题）',
      detail: '例如：线性代数、计算机网络、Rust 异步编程、信号与系统。如果已经在消息里说了，这里可以留空。',
    },
    {
      id: 'goal',
      header: '学习目标',
      question: '你希望这次学习达到什么目标？可多选，也可以直接输入自己的目标。',
      detail: '目标决定讲解深度、例题难度和测验形式：通过考试偏基础题型；取得高分偏阶梯难度与陷阱；理解原理偏推导与反例；实践应用会下载并带读开源项目。',
      options: goalOptions,
      multiSelect: true,
    },
    {
      id: 'materials',
      header: '参考资料',
      question: '有指定的参考资料吗？文献、书目、教材、课程或视频链接，一行一个。',
      detail: '留空则由我检索权威资料。支持：书名/作者、DOI/arXiv 编号、网址、本地文件路径。',
    },
    {
      id: 'level',
      header: '当前基础',
      question: '你目前的基础如何？（可选）',
      options: [
        { label: '零基础', description: '从最简单的概念开始，补足前置知识。' },
        { label: '学过一些但生疏', description: '先快速复习，再进入正课。' },
        { label: '有基础，想系统整理', description: '跳过入门，侧重结构与易错点。' },
        { label: '比较熟练，想深挖', description: '直接进入难点、边界与前沿。' },
      ],
    },
    {
      id: 'deadline',
      header: '时间与考核',
      question: '时间安排或考核形式？（可选）',
      detail: '例如：3 周后期末考，闭卷，选择题 + 计算题；或：两周后做项目答辩。',
    },
  ]
  if (existing !== undefined && profileHasContent(existing)) {
    questions[0].detail = '你之前已经填过学习档案，这里可以留空沿用；要改目标或资料就直接改。'
  }
  return questions
}

/**
 * Split a free-text materials answer into one item per line or semicolon.
 * @param {string} text Raw answer.
 * @returns {string[]} Non-empty material references.
 */
function splitMaterials(text) {
  return String(text)
    .split(/\r?\n|[;；]|\s+\/\s+/)
    .map(item => item.trim())
    .filter(item => item !== '')
}

/**
 * Turn a question answer batch into a profile.
 *
 * @param {{answers: Array<{id: string, selected: string[], custom?: string}>}} answer The human answer.
 * @returns {any} The normalized profile.
 */
export function profileFromAnswer(answer) {
  const byId = new Map((answer?.answers ?? []).map(item => [item.id, item]))
  const topicAnswer = byId.get('topic')
  const goalAnswer = byId.get('goal')
  const materialsAnswer = byId.get('materials')
  const levelAnswer = byId.get('level')
  const deadlineAnswer = byId.get('deadline')

  const topic = topicAnswer === undefined
    ? ''
    : (topicAnswer.custom?.trim() || (topicAnswer.selected ?? []).join(' ').trim())

  const goals = []
  const extraGoals = []
  for (const label of goalAnswer?.selected ?? []) {
    const goal = goalByLabel(label)
    if (goal !== undefined && !goals.includes(goal.id)) goals.push(goal.id)
  }
  const customGoal = goalAnswer?.custom?.trim() ?? ''
  if (customGoal !== '') {
    // A custom goal may also repeat an offered label; keep it only when it adds
    // information, so a learner who types "通过考试" does not create a duplicate.
    if (goalByLabel(customGoal) === undefined) extraGoals.push(customGoal)
  }

  const materials = materialsAnswer === undefined
    ? []
    : [
        ...(materialsAnswer.selected ?? []).filter(Boolean),
        ...splitMaterials(materialsAnswer.custom ?? ''),
      ]

  const level = levelAnswer === undefined
    ? ''
    : (levelAnswer.custom?.trim() || (levelAnswer.selected ?? []).join(' ').trim())
  const deadline = deadlineAnswer === undefined
    ? ''
    : (deadlineAnswer.custom?.trim() || (deadlineAnswer.selected ?? []).join(' ').trim())

  return normalizeProfile({
    topic,
    goals,
    materials,
    level,
    deadline,
    note: extraGoals.join('；'),
    updatedAt: new Date().toISOString(),
  })
}

/** Render the learner profile for the model, as a notice message. */
export function briefNoticeText(profile) {
  const goalLabels = GOALS.filter(goal => profile.goals.includes(goal.id)).map(goal => goal.label)
  const lines = []
  lines.push('学习档案已记录（教学模式启动）。把下面这份档案当作本次会话的权威简报：', '')
  lines.push(`- 学习内容：${profile.topic === '' ? '（未填写，请从对话中推断）' : profile.topic}`)
  lines.push(`- 学习目标：${goalLabels.length === 0 ? '（未填写）' : goalLabels.join(' / ')}${profile.note === '' ? '' : `；补充：${profile.note}`}`)
  if (profile.level !== '') lines.push(`- 当前基础：${profile.level}`)
  if (profile.deadline !== '') lines.push(`- 时间与考核：${profile.deadline}`)
  if (profile.materials.length === 0) {
    lines.push('- 参考资料：学习者没有指定，请自行检索权威资料并引用。')
  } else {
    lines.push('- 参考资料（优先级高于你自己搜索的结果）：')
    for (const material of profile.materials) lines.push(`  - ${material}`)
    lines.push('  先抓取/核验这些资料，开课时说明实际用到了哪几份；若某份无法访问或不相关，直接说明并改用同等可信的替代资料。')
  }
  lines.push(
    '',
    '下一步：用 teacher_course action "open" 打开课程大纲（模块按目标排序），然后按目标对应的方法开讲；每讲结束前用 teacher_notes 写笔记、用 teacher_quiz 出题。',
  )
  return lines.join('\n')
}

/** Render the notice injected when the form could not be shown. */
export function briefFallbackText(reason) {
  return [
    `教学模式启动，但没能通过弹窗收取学习档案（${reason}）。`,
    '',
    '请先用一条消息问清这四件事：想学什么；目标（通过考试 / 取得高分 / 理解原理 / 实践应用，可多选）；有没有指定参考资料（书名、文献、课程或视频链接）；当前基础和时间限制。',
    '然后用 teacher_brief 工具把答案记录下来，再按记录的目标开始教学。在收到答案之前，按默认方法（讲原理 + 基础例题）先开始，不要停下来空等。',
  ].join('\n')
}

/**
 * Create one notice message for the session log. The shape is the same as
 * `createUserMessage` produces (a fresh message id, the user role, typed text
 * blocks, and a producer source), built here so this module stays free of
 * harness imports and can be tested in isolation.
 *
 * @param {string} text Model-facing notice body.
 * @param {string} summary Short one-line account for collapsed rows.
 * @returns {{id: string, role: 'user', content: Array<{type: 'text', text: string}>, source: {kind: string, form: 'notice', summary: string}}} A user message with the teacher-mode source.
 */
function noticeMessage(text, summary) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'teacher-mode', form: 'notice', summary: summaryOf(summary) },
  }
}

/** Build the collected-profile notice. */
export function briefNotice(profile) {
  return noticeMessage(briefNoticeText(profile), `学习档案已记录：${profile.topic === '' ? '主题待定' : profile.topic}`)
}

/** Build the fallback notice. */
export function briefFallbackNotice(reason) {
  return noticeMessage(briefFallbackText(reason), '教师模式已启动，但未收集到学习档案')
}

/**
 * The per-session learner-profile owner: memory, the best-effort workspace
 * mirror, the welcome form, and the "already asked" mark.
 */
export class BriefManager {
  /**
   * @param {object} options Construction options.
   * @param {import('@deepseek-ai/cordis').Context} options.ctx Plugin context (logger, userQuestions).
   * @param {() => any} options.store Returns the course-file store, or undefined without `fs`.
   * @param {string} options.stateDir Workspace-relative state root.
   * @param {number} options.timeoutMs How long the welcome form may block a turn.
   */
  constructor(options) {
    this.ctx = options.ctx
    this.store = options.store
    this.stateDir = options.stateDir
    this.timeoutMs = options.timeoutMs
    /** @type {Map<string, any>} */
    this.cache = new Map()
    /** @type {WeakSet<object>} */
    this.asked = new WeakSet()
    /** @type {Set<string>} */
    this.askedIds = new Set()
  }

  /** The state path for one session. */
  pathOf(agent) {
    return briefPath(this.stateDir, String(agent.session.id))
  }

  /**
   * Whether this session has already been offered the welcome form (in this
   * process) or already carries a profile file.
   * @param {any} agent Live agent.
   * @returns {boolean} Whether to skip the form.
   */
  isAsked(agent) {
    return this.asked.has(agent.session) || this.askedIds.has(String(agent.session.id))
  }

  /** Remember that the form was shown, so a retry loop never re-opens it. */
  markAsked(agent) {
    this.asked.add(agent.session)
    this.askedIds.add(String(agent.session.id))
  }

  /**
   * Read the profile for a session: memory first, then the workspace mirror.
   * @param {any} agent Live agent.
   * @param {AbortSignal} [signal] Cancellation lifetime.
   * @returns {Promise<any | undefined>} The profile, or undefined when none exists.
   */
  async get(agent, signal) {
    const id = String(agent.session.id)
    if (this.cache.has(id)) return this.cache.get(id)
    const store = this.store()
    if (store === undefined) return undefined
    try {
      const text = await store.read(this.pathOf(agent), { agent, signal })
      if (text === undefined) return undefined
      const profile = normalizeProfile(JSON.parse(text))
      this.cache.set(id, profile)
      return profile
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-teacher-mode: could not read the learner profile: %o', error)
      return undefined
    }
  }

  /**
   * Record a profile in memory and mirror it to the workspace.
   * @param {any} agent Live agent.
   * @param {any} profile Profile to store.
   * @param {AbortSignal} [signal] Cancellation lifetime.
   * @returns {Promise<any>} The normalized profile actually stored.
   */
  async set(agent, profile, signal) {
    const normalized = normalizeProfile(profile)
    const id = String(agent.session.id)
    this.cache.set(id, normalized)
    this.askedIds.add(id)
    const store = this.store()
    if (store === undefined) return normalized
    try {
      await store.write(this.pathOf(agent), `${JSON.stringify(normalized, null, 2)}\n`, { agent, signal })
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-teacher-mode: could not persist the learner profile: %o', error)
    }
    return normalized
  }

  /**
   * Show the welcome form and record its answers.
   *
   * @param {any} agent Live agent.
   * @param {AbortSignal} turnSignal The turn's cancellation signal.
   * @returns {Promise<{kind: 'collected' | 'dismissed' | 'unavailable' | 'timeout', profile?: any, reason?: string}>} Outcome.
   */
  async collect(agent, turnSignal) {
    this.markAsked(agent)
    const interaction = this.ctx.get('userQuestions')
    if (interaction === undefined) return { kind: 'unavailable', reason: 'no question UI is available' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('welcome form timed out')), this.timeoutMs)
    const signal = turnSignal === undefined
      ? controller.signal
      : AbortSignal.any([turnSignal, controller.signal])
    let answer
    try {
      answer = await interaction.ask({
        questions: buildWelcomeQuestions(await this.get(agent, turnSignal)),
        agent,
        signal,
      })
    } catch (error) {
      const code = error?.code ?? ''
      if (controller.signal.aborted) return { kind: 'timeout', reason: 'the form timed out' }
      if (DISMISSED_CODES.has(code)) return { kind: 'dismissed', reason: 'the learner closed the form' }
      if (NO_CHANNEL_CODES.has(code) || code === 'ASK_ABORTED') {
        return { kind: 'unavailable', reason: code === 'ASK_ABORTED' ? 'the turn was interrupted' : 'no question UI is available' }
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
    const profile = await this.set(agent, profileFromAnswer(answer), turnSignal)
    return { kind: 'collected', profile }
  }
}
