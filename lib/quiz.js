/**
 * The `teacher_quiz` tool: asks the learner a graded quiz in the conversation's
 * own question UI, records the result in the course quiz log, and hands the
 * grading back to the tutor.
 *
 * All grading rules live in `grading.js` (pure functions); this module owns the
 * interaction, the model-facing tool schema, and the degraded paths when no
 * human can be asked.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { logEntry, normalizeQuestions, gradeQuiz, renderQuizResult, resolvePassRatio } from './grading.js'
import { courseLayout, renderQuizSection, stamp } from './paths.js'
import { appendFile } from './store.js'

/** Error codes the interaction channel reports when the learner walks away. */
const CANCELLED_CODES = new Set(['ASK_CANCELLED'])

/**
 * Error codes meaning "no human can be asked here": no UI provider is
 * registered, no question reached it, or the caller is a delegated/owned agent
 * with no answerer. Each degrades to handing the questions back to the model
 * rather than failing the call.
 */
const NO_CHANNEL_CODES = new Set(['NO_PROVIDER', 'EMPTY_QUESTIONS', 'CALLER_NOT_LIVE', 'DELEGATED_CALLER'])

/**
 * Register `teacher_quiz`.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Plugin context holding `ctx.tools`.
 * @param {{maxQuestions: number, passRatio: number, notesDir: string, store: () => any, activeCourse: (agent: any) => string | undefined, now: () => Date}} deps Quiz dependencies.
 */
export function registerQuizTool(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'teacher_quiz',
    description: 'Ask the learner a graded quiz about what you just taught, in the conversation\'s own question UI, '
      + 'and record the result in the course quiz log. Call it at the end of every lesson, before claiming the learner '
      + 'understands anything. Supply options plus the acceptable answer label(s) for auto-graded questions '
      + '(single-select unless multiSelect is true; for single select, list every acceptable label in `answer`). '
      + 'Omit options for open questions: the learner answers in free text and the result marks those as needing your '
      + 'own judgement. Never reveal the answer before the learner answers.',
    parameters: {
      topic: { type: 'string', required: true, description: 'What this quiz tests, e.g. "特征值与特征向量".' },
      questions: {
        type: 'array',
        required: true,
        description: 'The questions, in order. Mix recall, application, and one transfer question.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            question: { type: 'string', required: true, description: 'The question itself, self-contained.' },
            options: { type: 'array', items: { type: 'string' }, description: 'Choice labels. Omit for an open question.' },
            answer: { type: 'array', items: { type: 'string' }, required: true, description: 'Acceptable answer label(s); for an open question, the reference answer.' },
            explanation: { type: 'string', description: 'Why the answer is right, shown in the grading feedback.' },
            multiSelect: { type: 'boolean', description: 'True when several labels must be selected together.' },
          },
        },
      },
      course: { type: 'string', description: 'Course name. Defaults to the active course of teacher mode.' },
      passRatio: { type: 'number', description: 'Fraction of the auto-graded score that counts as passed, 0..1. Defaults to the plugin configured value.' },
      note: { type: 'string', description: 'One line for the quiz log, e.g. what to review next.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: ['graded', 'dismissed', 'no_channel'] },
          course: { type: 'string', required: true },
          topic: { type: 'string', required: true },
          gradable: { type: 'number', required: true },
          correct: { type: 'number', required: true },
          partial: { type: 'number', required: true },
          incorrect: { type: 'number', required: true },
          skipped: { type: 'number', required: true },
          needsReview: { type: 'number', required: true },
          score: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
          passed: { required: true, oneOf: [{ type: 'boolean' }, { type: 'null' }] },
          weakPoints: { type: 'array', required: true, items: { type: 'string' } },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                question: { type: 'string', required: true },
                verdict: { type: 'string', required: true, enum: ['correct', 'partial', 'incorrect', 'skipped', 'needs_review'] },
                expected: { type: 'array', required: true, items: { type: 'string' } },
                selected: { type: 'array', required: true, items: { type: 'string' } },
                custom: { type: 'string', required: true },
                responded: { type: 'string', required: true },
                explanation: { type: 'string', required: true },
              },
            },
          },
          logPath: { type: 'string', description: 'Workspace-relative quiz-log path, absent when nothing was logged.' },
          guidance: { type: 'string', required: true, description: 'What to do with this result.' },
        },
      },
      render: (_args, value) => {
        if (value.status === 'no_channel') {
          return [{ type: 'text', text: noChannelText(value.topic) }]
        }
        if (value.status === 'dismissed') {
          return [{ type: 'text', text: `The learner dismissed the "${value.topic}" quiz to say something instead. Stop the quiz, read their message, and answer it — do not re-ask the quiz unless they ask for it.` }]
        }
        const result = {
          outcomes: value.results.map(row => ({
            id: row.id,
            question: row.question,
            verdict: row.verdict,
            expected: row.expected,
            selected: row.selected,
            custom: row.custom,
            responded: row.responded,
            explanation: row.explanation,
          })),
          gradable: value.gradable,
          correct: value.correct,
          partial: value.partial,
          incorrect: value.incorrect,
          skipped: value.skipped,
          needsReview: value.needsReview,
          score: value.score ?? undefined,
          passed: value.passed ?? undefined,
          weakPoints: value.weakPoints,
        }
        return [{ type: 'text', text: renderQuizResult(value.topic, result, value.logPath ?? '(not logged)') }]
      },
    },
    execute: async (args, exec) => {
      const questions = normalizeQuestions(args.questions, deps.maxQuestions)
      const course = args.course?.trim() || deps.activeCourse(exec.agent)
      if (course === undefined) {
        throw new Error('teacher_quiz needs a course: pass `course`, or open one first with teacher_course')
      }
      const passRatio = resolvePassRatio(args.passRatio, deps.passRatio)
      const interaction = ctx.get('userQuestions')

      if (interaction === undefined) return noChannelResult(questions, course, args.topic)

      const request = {
        questions: questions.map(question => ({
          id: question.id,
          header: args.topic,
          question: question.question,
          ...question.options === undefined || question.options.length === 0
            ? {}
            : { options: question.options.map(label => ({ label })) },
          ...question.multiSelect === true ? { multiSelect: true } : {},
        })),
        ...exec.agent === undefined ? {} : { agent: exec.agent },
        signal: exec.signal,
      }

      let answer
      try {
        answer = await interaction.ask(request)
      } catch (error) {
        const code = error?.code ?? ''
        // The learner took the turn back to speak: not a failed tool call.
        if (CANCELLED_CODES.has(code)) return dismissedResult(course, args.topic)
        // No human can answer here (no UI provider, or a delegated caller):
        // hand the questions back instead of failing the call.
        if (NO_CHANNEL_CODES.has(code)) return noChannelResult(questions, course, args.topic)
        throw error
      }

      const graded = gradeQuiz(questions, answer.answers, passRatio)
      const date = stamp(deps.now())
      const section = renderQuizSection({
        topic: args.topic,
        score: graded.score,
        correct: graded.correct,
        gradable: graded.gradable,
        passed: graded.passed,
        entries: graded.outcomes.map(logEntry),
        ...args.note === undefined ? {} : { note: args.note },
        date,
      })
      const store = deps.store()
      let logPath
      if (store !== undefined) {
        const { file } = await appendFile(
          store,
          courseLayout(deps.notesDir, course).quizzes,
          `${section}\n`,
          `# ${course} · quizzes\n\nQuiz history kept by dsh-teacher-mode.\n\n`,
          exec,
        )
        logPath = file.path
      }

      return {
        status: 'graded',
        course,
        topic: args.topic,
        gradable: graded.gradable,
        correct: graded.correct,
        partial: graded.partial,
        incorrect: graded.incorrect,
        skipped: graded.skipped,
        needsReview: graded.needsReview,
        score: graded.score ?? null,
        passed: graded.passed ?? null,
        weakPoints: graded.weakPoints,
        results: graded.outcomes.map(outcome => ({
          id: outcome.id,
          question: outcome.question,
          verdict: outcome.verdict,
          expected: [...outcome.expected],
          selected: [...outcome.selected],
          custom: outcome.custom,
          responded: outcome.responded,
          explanation: outcome.explanation,
        })),
        ...logPath === undefined ? {} : { logPath },
        guidance: graded.weakPoints.length === 0
          ? 'Everything answered correctly: confirm the mastery in one sentence, then propose the next topic or module.'
          : 'Re-teach the weak points with different explanations and new examples, then re-quiz only those points.',
      }
    },
  }))
}

/** Text returned when no interactive question channel is composed. */
function noChannelText(topic) {
  return `No interactive question channel is available, so the "${topic}" quiz could not be asked directly. `
    + 'Put the questions to the learner in your own message, wait for their answers, and grade them yourself — '
    + 'do not treat this as a completed quiz.'
}

/**
 * The result returned when the questions could not be put to a human. Every
 * question is reported as `skipped` with its reference answer, so the model can
 * run the quiz in chat without losing anything.
 *
 * @param {object[]} questions The validated questions.
 * @param {string} course The course the quiz belongs to.
 * @param {string} topic What the quiz tests.
 * @returns {object} The canonical no-channel outcome.
 */
function noChannelResult(questions, course, topic) {
  return {
    status: 'no_channel',
    course,
    topic,
    gradable: questions.length,
    correct: 0,
    partial: 0,
    incorrect: 0,
    skipped: 0,
    needsReview: questions.length,
    score: null,
    passed: null,
    weakPoints: [],
    results: questions.map(question => ({
      id: question.id,
      question: question.question,
      verdict: 'skipped',
      expected: [...question.answer],
      selected: [],
      custom: '',
      responded: '',
      explanation: question.explanation ?? '',
    })),
    guidance: 'No interactive question channel is available: put these questions to the learner in chat, wait for their answers, and grade them yourself.',
  }
}

/**
 * The result returned when the learner dismissed the quiz to speak instead.
 *
 * @param {string} course The course the quiz belongs to.
 * @param {string} topic What the quiz tests.
 * @returns {object} The canonical dismissed outcome.
 */
function dismissedResult(course, topic) {
  return {
    status: 'dismissed',
    course,
    topic,
    gradable: 0,
    correct: 0,
    partial: 0,
    incorrect: 0,
    skipped: 0,
    needsReview: 0,
    score: null,
    passed: null,
    weakPoints: [],
    results: [],
    guidance: 'The learner dismissed the quiz to speak instead; answer whatever they say.',
  }
}
