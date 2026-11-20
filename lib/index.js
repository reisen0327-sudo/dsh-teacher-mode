/**
 * Teacher mode for DeepSeek Harness: a selectable agent preset that teaches.
 *
 * The plugin contributes three things to the preset it is mounted in:
 *
 * - a welcome form that runs before the first tool call and records the
 *   learner's goals, reference materials, level, and time constraints;
 * - a guidance section that adapts the teaching method to those goals;
 * - the tools that make the guidance enforceable — `teacher_brief` owns the
 *   profile, `teacher_course` the syllabus, `teacher_notes` the class notes,
 *   and `teacher_quiz` the graded quiz with its log.
 *
 * Everything is scoped to the preset, so the tools and the guidance exist only
 * in sessions composed from the teacher preset. The profile is per session: it
 * lives in memory and mirrors to the workspace so a resumed session keeps it.
 *
 * @module dsh-teacher-mode
 */

import { BriefManager, briefFallbackNotice, briefNotice } from './brief.js'
import { registerBriefTool, registerCourseTools } from './course.js'
import { profileHasContent, renderTeacherPolicy } from './policy.js'
import { registerQuizTool } from './quiz.js'
import { createNoteStore } from './store.js'

/** Cordis plugin name. */
export const name = 'teacher-mode'

/** Services the tool surface needs. */
export const inject = ['tools', 'systemPrompt']

/** Every configuration key this plugin accepts. */
const CONFIG_KEYS = [
  'notesDir',
  'stateDir',
  'maxQuizQuestions',
  'passRatio',
  'askOnStart',
  'briefTimeoutMs',
  'policy',
]

/** Default configuration. */
const DEFAULT_CONFIG = {
  notesDir: 'teacher-notes',
  stateDir: '.dsh-teacher',
  maxQuizQuestions: 8,
  passRatio: 0.8,
  askOnStart: true,
  briefTimeoutMs: 600000,
}

/**
 * Validate deployment configuration. Unknown keys and unusable values fail at
 * plugin load rather than being ignored.
 *
 * @param {object} [config] Raw plugin config.
 * @returns {object} A detached validated config.
 */
export function resolveConfig(config = {}) {
  const unknown = Object.keys(config).filter(key => !CONFIG_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new Error(`TeacherModeConfig has unknown key(s) ${unknown.join(', ')} — config is { ${CONFIG_KEYS.join(', ')} }`)
  }
  const relative = (value, field, fallback) => {
    const text = String(value ?? fallback).trim().replace(/[\\/]+$/, '')
    if (text === '') throw new Error(`TeacherModeConfig needs a non-empty \`${field}\``)
    if (/^[a-zA-Z]:/.test(text) || text.startsWith('/') || text.split(/[\\/]+/).includes('..')) {
      throw new Error(`TeacherModeConfig \`${field}\` must be a workspace-relative path inside the session workspace`)
    }
    return text
  }
  const maxQuizQuestions = config.maxQuizQuestions ?? DEFAULT_CONFIG.maxQuizQuestions
  if (!Number.isInteger(maxQuizQuestions) || maxQuizQuestions < 1 || maxQuizQuestions > 20) {
    throw new Error('TeacherModeConfig `maxQuizQuestions` must be an integer between 1 and 20')
  }
  const passRatio = config.passRatio ?? DEFAULT_CONFIG.passRatio
  if (!Number.isFinite(passRatio) || passRatio <= 0 || passRatio > 1) {
    throw new Error('TeacherModeConfig `passRatio` must be a fraction greater than 0 and at most 1')
  }
  const briefTimeoutMs = config.briefTimeoutMs ?? DEFAULT_CONFIG.briefTimeoutMs
  if (!Number.isInteger(briefTimeoutMs) || briefTimeoutMs < 5000 || briefTimeoutMs > 86400000) {
    throw new Error('TeacherModeConfig `briefTimeoutMs` must be an integer between 5000 and 86400000')
  }
  if (config.policy !== undefined && String(config.policy).trim() === '') {
    throw new Error('TeacherModeConfig `policy` must be non-empty when present (omit it to use the built-in teaching protocol)')
  }
  return {
    notesDir: relative(config.notesDir, 'notesDir', DEFAULT_CONFIG.notesDir),
    stateDir: relative(config.stateDir, 'stateDir', DEFAULT_CONFIG.stateDir),
    maxQuizQuestions,
    passRatio,
    askOnStart: config.askOnStart ?? DEFAULT_CONFIG.askOnStart,
    briefTimeoutMs,
    ...config.policy === undefined ? {} : { policy: String(config.policy) },
  }
}

/**
 * Mount teacher mode.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx The preset-scoped context.
 * @param {object} [config] Deployment configuration.
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const now = () => new Date()
  /** Course-file store; assigned when a filesystem is composed. */
  let store

  const briefs = new BriefManager({
    ctx,
    store: () => store,
    stateDir: resolved.stateDir,
    timeoutMs: resolved.briefTimeoutMs,
  })

  /** The profile already loaded for this agent, without touching the filesystem. */
  const profileOf = (agent) => agent === undefined ? undefined : briefs.cache.get(String(agent.session.id))

  // The course a session is teaching, read from the same profile record.
  const activeCourse = agent => profileOf(agent)?.course || undefined

  /**
   * Record the canonical course name on the profile. Between turns the write is
   * synchronous in memory; the mirror is updated best effort, and a tool call
   * that follows can rely on the memory value regardless.
   */
  const setCourse = async (agent, course, signal) => {
    if (agent === undefined) return
    const current = profileOf(agent) ?? { version: 1, topic: '', goals: [], materials: [], level: '', deadline: '', note: '', course: '', updatedAt: '' }
    await briefs.set(agent, { ...current, course }, signal)
  }

  // Deployment guidance: rendered on every assembly, adapted to the recorded
  // profile. The section exists only inside this preset's scope.
  ctx.systemPrompt.section({
    name: 'teacher:policy',
    order: 51,
    text: (context) => {
      if (context.agent === undefined) return ''
      return renderTeacherPolicy({
        notesDir: resolved.notesDir,
        maxQuizQuestions: resolved.maxQuizQuestions,
        profile: profileOf(context.agent),
        ...resolved.policy === undefined ? {} : { override: resolved.policy },
      })
    },
  })

  /**
   * The welcome form. Runs once per session, before the first model request of
   * the first turn, so the very first tool call already has the learners' goals
   * and materials. A subagent never asks a human.
   */
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    if (agent.session.header.origin === 'subagent') return decision
    try {
      const existing = await briefs.get(agent, signal)
      if (briefs.isAsked(agent)) return decision
      if (existing !== undefined && profileHasContent(existing)) {
        briefs.markAsked(agent)
        return decision
      }
      if (!resolved.askOnStart) {
        briefs.markAsked(agent)
        return decision
      }
      const outcome = await briefs.collect(agent, signal)
      if (signal.aborted) return decision
      if (outcome.kind === 'collected') {
        return { ...decision, messages: [...decision.messages, briefNotice(outcome.profile)] }
      }
      const reason = outcome.reason ?? 'unknown reason'
      return { ...decision, messages: [...decision.messages, briefFallbackNotice(reason)] }
    } catch (error) {
      ctx.logger.warn('dsh-teacher-mode: the welcome form failed; teaching continues without a profile: %o', error)
      briefs.markAsked(agent)
      return decision
    }
  })

  // Course tools need a filesystem; a composition without `fs` keeps the
  // profile and quiz working, it just cannot write course files.
  ctx.inject(['fs'], (fsCtx) => {
    const activeStore = createNoteStore(fsCtx)
    store = activeStore
    registerCourseTools(fsCtx, {
      store: activeStore,
      notesDir: resolved.notesDir,
      activeCourse,
      setCourse: (agent, course, signal) => setCourse(agent, course, signal),
      now,
    })
    ctx.logger.debug('dsh-teacher-mode: course and notes tools registered')
  })

  registerBriefTool(ctx, { briefs, now })
  registerQuizTool(ctx, {
    maxQuestions: resolved.maxQuizQuestions,
    passRatio: resolved.passRatio,
    notesDir: resolved.notesDir,
    store: () => store,
    activeCourse,
    now,
  })

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'teacher',
      description: 'Show or update the teacher-mode learning profile',
      input: { hint: '[status|brief|help]' },
      handler: async ({ agent, rawInput, signal }) => {
        const verb = rawInput.trim().toLowerCase()
        if (verb === 'help') {
          return {
            kind: 'success',
            text: 'Teacher mode is a session preset, not a switch: start a new session with the 教学模式 preset to study. '
              + '/teacher status shows the recorded profile; /teacher brief re-opens the welcome form to change goals or materials.',
          }
        }
        if (verb === 'brief' || verb === '') {
          const outcome = await briefs.collect(agent, signal)
          if (outcome.kind === 'collected') {
            const profile = outcome.profile
            return {
              kind: 'success',
              text: `Learning profile updated (${profile.goals.length} goal(s), ${profile.materials.length} material(s)). `
                + 'The tutor now teaches to it.',
            }
          }
          return {
            kind: 'error',
            text: `The welcome form was not completed: ${outcome.reason ?? outcome.kind}. `
              + 'Tell the tutor what you want to study and your goals in chat instead.',
          }
        }
        if (verb === 'status') {
          const profile = await briefs.get(agent, signal)
          if (profile === undefined) {
            return { kind: 'success', text: 'No learning profile is recorded for this session yet. Use /teacher brief to fill it in.' }
          }
          const goals = profile.goals.length === 0 ? '(not set)' : profile.goals.join(', ')
          const materials = profile.materials.length === 0 ? 'none' : profile.materials.join('; ')
          return {
            kind: 'success',
            text: `Teacher mode · ${profile.topic === '' ? 'topic not set' : profile.topic} · goals: ${goals}`
              + ` · level: ${profile.level === '' ? 'not set' : profile.level}`
              + ` · materials: ${materials}`
              + (profile.course === '' ? '' : ` · active course: ${profile.course}`),
          }
        }
        return { kind: 'error', text: `Unknown /teacher argument "${rawInput.trim()}". Try /teacher status, /teacher brief, or /teacher help.` }
      },
    })
  })
}
