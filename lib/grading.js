/**
 * Pure quiz grading. Questions and answers in, verdicts out, so the score, the
 * weak-point list, and the quiz-log entry are one computation rather than three
 * copies of the same rules. This module imports nothing, which keeps the rules
 * testable without a harness.
 */

/** Normalize a label or typed answer for comparison. */
export function normalizeAnswer(value) {
  return String(value)
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^["'“”‘’(（\[]+|["'“”‘’)\]）]+$/g, '')
    .replace(/[.。,，;；:：!！?？]+$/g, '')
    .toLowerCase()
}

/**
 * Grade one quiz.
 *
 * Rules, in one place so the model can rely on them:
 * - a single-select question is correct when the answer matches ANY declared
 *   acceptable label (a typed answer is compared too, so variants can list);
 * - a multi-select question needs exactly the declared set; a non-empty proper
 *   subset scores half;
 * - a question with no options is never auto-graded: the model judges it, so it
 *   is reported as `needs_review` and left out of the score;
 * - an answer with neither a selection nor text is `skipped`, and still counts
 *   toward the denominator.
 *
 * @param {Array<{id: string, question: string, options?: string[], answer: string[], explanation?: string, multiSelect?: boolean}>} questions The asked questions, in order.
 * @param {Array<{id: string, selected: string[], custom?: string}>} answers The answers the learner gave.
 * @param {number} passRatio Fraction in `0..1` that counts as passed.
 * @returns {{outcomes: object[], gradable: number, correct: number, partial: number, incorrect: number, skipped: number, needsReview: number, score: number | undefined, passed: boolean | undefined, weakPoints: string[]}} Verdicts, counts, score, and the weak points to re-teach.
 */
export function gradeQuiz(questions, answers, passRatio) {
  const byId = new Map((answers ?? []).map(answer => [answer.id, answer]))
  const outcomes = questions.map((question) => {
    const answer = byId.get(question.id)
    const selected = answer?.selected ?? []
    const custom = answer?.custom?.trim() ?? ''
    const expected = [...question.answer]
    const base = {
      id: question.id,
      question: question.question,
      expected,
      selected,
      custom,
      explanation: question.explanation ?? '',
    }

    // No answer at all.
    if (selected.length === 0 && custom === '') {
      return { ...base, verdict: 'skipped', responded: '(no answer)' }
    }

    // An open question is the model's to judge, not this function's.
    if (question.options === undefined || question.options.length === 0) {
      const responded = custom === '' ? selected.join(', ') : custom
      return { ...base, verdict: 'needs_review', responded }
    }

    if (question.multiSelect === true) {
      if (custom !== '') {
        // Free text over selected labels: only the model can judge intent.
        return { ...base, verdict: 'needs_review', responded: custom }
      }
      const expectedSet = new Set(expected.map(normalizeAnswer))
      const selectedSet = new Set(selected.map(normalizeAnswer))
      const responded = selected.join(', ')
      if (selectedSet.size === expectedSet.size && [...selectedSet].every(label => expectedSet.has(label))) {
        return { ...base, verdict: 'correct', responded }
      }
      const subset = selectedSet.size > 0 && [...selectedSet].every(label => expectedSet.has(label))
      return { ...base, verdict: subset ? 'partial' : 'incorrect', responded }
    }

    // Single select: an explicit "other" answer overrides the selection.
    const responded = custom === '' ? selected[0] : custom
    const acceptable = new Set(expected.map(normalizeAnswer))
    const verdict = acceptable.has(normalizeAnswer(responded)) ? 'correct' : 'incorrect'
    return { ...base, verdict, responded }
  })

  const count = verdict => outcomes.filter(outcome => outcome.verdict === verdict).length
  const correct = count('correct')
  const partial = count('partial')
  const incorrect = count('incorrect')
  const skipped = count('skipped')
  const needsReview = count('needs_review')
  const gradable = outcomes.filter(outcome => outcome.expected.length > 0 && outcome.verdict !== 'needs_review').length
  const score = gradable === 0 ? undefined : (correct + partial * 0.5) / gradable
  return {
    outcomes,
    gradable,
    correct,
    partial,
    incorrect,
    skipped,
    needsReview,
    score,
    passed: score === undefined ? undefined : score >= passRatio,
    weakPoints: outcomes.filter(outcome => outcome.verdict !== 'correct').map(outcome => outcome.question),
  }
}

/**
 * Model-facing rendering of one graded quiz.
 * @param {string} topic What the quiz tested.
 * @param {object} result Grading result.
 * @param {string} logPath Where the quiz was logged.
 * @returns {string} The tool result text.
 */
export function renderQuizResult(topic, result, logPath) {
  const lines = []
  const percent = result.score === undefined ? 'nothing auto-gradable' : `${Math.round(result.score * 100)}%`
  lines.push(`Quiz "${topic}": ${result.correct}/${result.gradable} correct (${percent})${result.passed === true ? ' — passed' : result.passed === false ? ' — needs review' : ''}`)
  lines.push('')
  for (const outcome of result.outcomes) {
    const mark = outcome.verdict === 'correct'
      ? 'correct'
      : outcome.verdict === 'partial'
        ? 'partial credit'
        : outcome.verdict === 'skipped'
          ? 'skipped'
          : outcome.verdict === 'needs_review'
            ? 'your judgement needed'
            : 'incorrect'
    const parts = [`- [${mark}] ${outcome.question}`, `  answered: ${outcome.responded}`]
    if (outcome.verdict !== 'correct' && outcome.expected.length > 0) parts.push(`  expected: ${outcome.expected.join(' / ')}`)
    if (outcome.explanation !== '') parts.push(`  explanation: ${outcome.explanation}`)
    lines.push(parts.join('\n'))
  }
  if (result.needsReview > 0) {
    lines.push('')
    lines.push(`${result.needsReview} question(s) were answered in free text: judge each answer yourself against the reference answer and say whether it is right, then correct it if not.`)
  }
  lines.push('')
  lines.push('Next: explain every incorrect or partial answer in full, re-teach each weak point with a DIFFERENT explanation and a NEW example, then re-quiz those points with new questions. Do not re-ask questions the learner already answered correctly.')
  lines.push(`Quiz log: ${logPath}`)
  return lines.join('\n')
}

/** Format the learner's answer for the quiz log. */
export function logEntry(outcome) {
  return {
    question: outcome.question,
    verdict: outcome.verdict,
    responded: outcome.responded,
    ...outcome.expected.length === 0 ? {} : { expected: outcome.expected.join(' / ') },
  }
}

/**
 * Validate and identify the questions before they reach the interaction channel.
 * @param {object[]} raw Model-supplied questions.
 * @param {number} maxQuestions Ceiling on one quiz.
 * @returns {object[]} Normalized questions with stable ids.
 */
export function normalizeQuestions(raw, maxQuestions) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('teacher_quiz needs at least one question')
  if (raw.length > maxQuestions) {
    throw new Error(`teacher_quiz accepts at most ${maxQuestions} questions at a time; split the quiz into rounds`)
  }
  return raw.map((question, index) => {
    const id = `q${index + 1}`
    const text = String(question.question ?? '').trim()
    if (text === '') throw new Error(`${id}: every quiz question needs non-empty text`)
    const options = Array.isArray(question.options)
      ? question.options.map(option => String(option).trim()).filter(option => option !== '')
      : undefined
    const answer = Array.isArray(question.answer)
      ? question.answer.map(label => String(label).trim()).filter(label => label !== '')
      : []
    if (answer.length === 0) throw new Error(`${id}: every quiz question needs at least one acceptable answer`)
    if (question.multiSelect === true && (options === undefined || options.length === 0)) {
      throw new Error(`${id}: multiSelect requires options`)
    }
    if (options !== undefined && options.length > 0) {
      const known = new Set(options)
      for (const label of answer) {
        if (!known.has(label)) {
          throw new Error(`${id}: answer "${label}" is not one of the options; single-select questions accept any listed label`)
        }
      }
    }
    return {
      id,
      question: text,
      ...options === undefined || options.length === 0 ? {} : { options },
      answer,
      ...question.explanation === undefined || String(question.explanation).trim() === ''
        ? {}
        : { explanation: String(question.explanation).trim() },
      ...question.multiSelect === true ? { multiSelect: true } : {},
    }
  })
}

/** Clamp a model-supplied pass ratio. */
export function resolvePassRatio(requested, fallback) {
  if (requested === undefined) return fallback
  if (!Number.isFinite(requested) || requested <= 0 || requested > 1) {
    throw new Error('passRatio must be a fraction greater than 0 and at most 1')
  }
  return requested
}
