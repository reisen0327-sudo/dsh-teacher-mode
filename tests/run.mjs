/**
 * Unit tests for the pure modules of dsh-teacher-mode. They run without the
 * harness: paths, policy, grading, and the profile parser have no harness
 * imports on purpose, and the tool registration files are exercised by the
 * harness itself when the preset mounts.
 */

import assert from 'node:assert/strict'
import {
  briefPath,
  courseLayout,
  parseModules,
  renderNoteSection,
  renderQuizSection,
  renderSyllabus,
  slugifyCourse,
  stamp,
  toggleModule,
  upsertSection,
} from '../lib/paths.js'
import {
  renderProfileBlock,
  renderTeacherPolicy,
  GOALS,
  normalizeProfile,
  profileHasContent,
  renderGoalMethod,
} from '../lib/policy.js'
import { gradeQuiz, normalizeQuestions, resolvePassRatio } from '../lib/grading.js'
import {
  briefFallbackText,
  briefNoticeText,
  buildWelcomeQuestions,
  profileFromAnswer,
} from '../lib/brief.js'

let passed = 0
const failures = []

/** Run one named test. */
function test(name, body) {
  try {
    body()
    passed += 1
  } catch (error) {
    failures.push({ name, error })
  }
}

test('slugifyCourse keeps CJK and strips separators', () => {
  assert.equal(slugifyCourse('线性代数'), '线性代数')
  assert.equal(slugifyCourse('MIT 18.06 / Linear Algebra'), 'MIT-18.06-Linear-Algebra')
  assert.equal(slugifyCourse('  ...  '), 'course')
  assert.equal(slugifyCourse('../etc/passwd'), 'etc-passwd')
})

test('courseLayout nests under the notes root', () => {
  const layout = courseLayout('teacher-notes', '线性代数')
  assert.equal(layout.dir, 'teacher-notes/线性代数')
  assert.equal(layout.syllabus, 'teacher-notes/线性代数/syllabus.md')
  assert.equal(layout.notes, 'teacher-notes/线性代数/notes.md')
  assert.equal(layout.quizzes, 'teacher-notes/线性代数/quizzes.md')
})

test('briefPath stays inside the state root', () => {
  assert.equal(briefPath('.dsh-teacher', 'abc-123'), '.dsh-teacher/abc-123.json')
  assert.equal(briefPath('.dsh-teacher', 'a/b'), '.dsh-teacher/a-b.json')
})

test('syllabus round-trips modules and checkboxes', () => {
  const markdown = renderSyllabus({
    course: '线性代数',
    goal: '3 周后考试',
    level: '零基础',
    modules: [
      { id: 'm1', title: '行列式', objectives: ['会算 2x2', '知道几何意义'] },
      { id: 'm2', title: '矩阵', done: true },
    ],
    sources: [{ title: 'MIT 18.06', url: 'https://ocw.mit.edu' }],
    date: '2026-11-21',
  })
  const modules = parseModules(markdown)
  assert.deepEqual(modules.map(module => [module.id, module.done]), [['m1', false], ['m2', true]])
  assert.match(markdown, /## Sources/)
  assert.match(markdown, /\[MIT 18\.06\]\(https:\/\/ocw\.mit\.edu\)/)
  const toggled = toggleModule(markdown, 'm1', true)
  assert.equal(toggled.changed, true)
  assert.equal(parseModules(toggled.text)[0].done, true)
  assert.equal(toggleModule(markdown, 'nope', true).changed, false)
})

test('notes sections append and refuse silent duplicates', () => {
  const section = renderNoteSection({ lesson: '第 1 讲', body: '正文', keyPoints: ['要点'], date: '2026-11-21' })
  assert.match(section, /^## 第 1 讲/)
  const first = upsertSection('', '第 1 讲', section, false)
  assert.equal(first.kind, 'written')
  const duplicate = upsertSection(first.text, '第 1 讲', section, false)
  assert.equal(duplicate.kind, 'duplicate')
  const replaced = upsertSection(first.text, '第 1 讲', renderNoteSection({ lesson: '第 1 讲', body: '新正文', date: '2026-11-22' }), true)
  assert.equal(replaced.kind, 'written')
  assert.match(replaced.text, /新正文/)
  assert.doesNotMatch(replaced.text, /要点/)
})

test('quiz sections render the score and wrong answers', () => {
  const text = renderQuizSection({
    topic: '特征值',
    score: 0.5,
    correct: 1,
    gradable: 2,
    passed: false,
    entries: [
      { question: 'q1', verdict: 'correct', responded: 'A' },
      { question: 'q2', verdict: 'incorrect', responded: 'B', expected: 'C' },
    ],
    date: '2026-11-21',
  })
  assert.match(text, /1\/2 \(50%\) · needs review/)
  assert.match(text, /expected: C/)
})

test('stamp is a local YYYY-MM-DD date', () => {
  assert.match(stamp(new Date(2026, 0, 5)), /^2026-01-05$/)
})

test('normalizeProfile drops unknown goals and blanks', () => {
  const profile = normalizeProfile({
    topic: ' 信号与系统 ',
    goals: ['pass', 'bogus', 'pass'],
    materials: ['书', '  ', ''],
    level: ' 零基础 ',
    extra: 'ignored',
  })
  assert.equal(profile.topic, '信号与系统')
  assert.deepEqual(profile.goals, ['pass'])
  assert.deepEqual(profile.materials, ['书'])
  assert.equal(profile.level, '零基础')
  assert.equal(profileHasContent(profile), true)
  assert.equal(profileHasContent(normalizeProfile({})), false)
})

test('every goal has a distinct display label and a method', () => {
  const labels = new Set(GOALS.map(goal => goal.label))
  assert.equal(labels.size, GOALS.length)
  for (const goal of GOALS) assert.ok(goal.method.length > 100, `${goal.id} needs a substantive method`)
})

test('goal methods combine when several goals are selected', () => {
  const text = renderGoalMethod(['pass', 'practice'])
  assert.match(text, /Exam-pass goal/)
  assert.match(text, /Practice goal/)
  assert.match(text, /Combining goals/)
  assert.match(renderGoalMethod([]), /No explicit goal was recorded/)
})

test('profile block lists supplied materials and their precedence', () => {
  const text = renderProfileBlock(normalizeProfile({
    topic: '线性代数',
    goals: ['score'],
    materials: ['Gilbert Strang, Introduction to Linear Algebra', 'https://ocw.mit.edu/18.06'],
    level: '有基础',
    deadline: '3 周后期末考',
  }))
  assert.match(text, /线性代数/)
  assert.match(text, /取得高分/)
  assert.match(text, /outrank anything you find by search/)
  assert.match(text, /High-score goal/)
})

test('policy render substitutes placeholders and appends the profile', () => {
  const text = renderTeacherPolicy({
    notesDir: 'teacher-notes',
    maxQuizQuestions: 8,
    profile: normalizeProfile({ goals: ['principle'] }),
  })
  assert.match(text, /teacher-notes/)
  assert.doesNotMatch(text, /\{\{NOTES_DIR\}\}/)
  assert.match(text, /Principle goal/)
})

test('grading: single select accepts any listed label', () => {
  const result = gradeQuiz(
    [{ id: 'q1', question: 'q', options: ['A', 'B'], answer: ['A', 'B'] }],
    [{ id: 'q1', selected: ['B'] }],
    0.8,
  )
  assert.equal(result.outcomes[0].verdict, 'correct')
  assert.equal(result.score, 1)
  assert.equal(result.passed, true)
})

test('grading: multi select needs the exact set, subset is half', () => {
  const exact = gradeQuiz(
    [{ id: 'q1', question: 'q', options: ['A', 'B'], answer: ['A', 'B'], multiSelect: true }],
    [{ id: 'q1', selected: ['A', 'B'] }],
    0.8,
  )
  assert.equal(exact.outcomes[0].verdict, 'correct')
  const subset = gradeQuiz(
    [{ id: 'q1', question: 'q', options: ['A', 'B', 'C'], answer: ['A', 'B'], multiSelect: true }],
    [{ id: 'q1', selected: ['A'] }],
    0.8,
  )
  assert.equal(subset.outcomes[0].verdict, 'partial')
  assert.equal(subset.score, 0.5)
  assert.equal(subset.passed, false)
})

test('grading: open questions need review and skip the score', () => {
  const result = gradeQuiz(
    [{ id: 'q1', question: 'explain', answer: ['reference'] }],
    [{ id: 'q1', selected: [], custom: '我的解释' }],
    0.8,
  )
  assert.equal(result.outcomes[0].verdict, 'needs_review')
  assert.equal(result.gradable, 0)
  assert.equal(result.score, undefined)
  assert.equal(result.passed, undefined)
})

test('grading: skipped answers count in the denominator', () => {
  const result = gradeQuiz(
    [
      { id: 'q1', question: 'q1', options: ['A'], answer: ['A'] },
      { id: 'q2', question: 'q2', options: ['A'], answer: ['A'] },
    ],
    [{ id: 'q1', selected: ['A'] }],
    0.8,
  )
  assert.equal(result.outcomes[1].verdict, 'skipped')
  assert.equal(result.gradable, 2)
  assert.equal(result.score, 0.5)
})

test('normalizeQuestions rejects incoherent quizzes', () => {
  assert.throws(() => normalizeQuestions([], 8), /at least one question/)
  assert.throws(() => normalizeQuestions([{ question: 'q', answer: [] }], 8), /acceptable answer/)
  assert.throws(
    () => normalizeQuestions([{ question: 'q', options: ['A'], answer: ['B'] }], 8),
    /not one of the options/,
  )
  assert.throws(
    () => normalizeQuestions([{ question: 'q', options: [], answer: ['A'], multiSelect: true }], 8),
    /multiSelect requires options/,
  )
  const normalized = normalizeQuestions([{ question: ' q ', options: ['A', ' B '], answer: ['A'] }], 8)
  assert.deepEqual(normalized[0].options, ['A', 'B'])
  assert.equal(normalized[0].id, 'q1')
})

test('resolvePassRatio clamps model input', () => {
  assert.equal(resolvePassRatio(undefined, 0.8), 0.8)
  assert.equal(resolvePassRatio(0.5, 0.8), 0.5)
  assert.throws(() => resolvePassRatio(0, 0.8), /fraction/)
  assert.throws(() => resolvePassRatio(1.5, 0.8), /fraction/)
})

test('profileFromAnswer maps labels to stable ids and keeps materials', () => {
  const profile = profileFromAnswer({
    answers: [
      { id: 'topic', selected: [], custom: '线性代数' },
      { id: 'goal', selected: ['通过考试', '理解原理'], custom: '还想会算' },
      { id: 'materials', selected: [], custom: 'Gilbert Strang 教材\nhttps://ocw.mit.edu/18.06；本地 C:\\notes\\ch1.pdf' },
      { id: 'level', selected: ['零基础'] },
      { id: 'deadline', selected: [], custom: '3 周后期末考' },
    ],
  })
  assert.equal(profile.topic, '线性代数')
  assert.deepEqual(profile.goals, ['pass', 'principle'])
  assert.equal(profile.note, '还想会算')
  assert.equal(profile.materials.length, 3)
  assert.equal(profile.materials[2], '本地 C:\\notes\\ch1.pdf')
  assert.equal(profile.level, '零基础')
  assert.equal(profile.deadline, '3 周后期末考')
})

test('profileFromAnswer tolerates a skipped form', () => {
  const profile = profileFromAnswer({ answers: [{ id: 'goal', selected: [] }, { id: 'topic', selected: [] }] })
  assert.equal(profileHasContent(profile), false)
})

test('welcome form offers all four goals and asks for materials', () => {
  const questions = buildWelcomeQuestions()
  assert.deepEqual(questions.map(question => question.id), ['topic', 'goal', 'materials', 'level', 'deadline'])
  const goal = questions.find(question => question.id === 'goal')
  assert.equal(goal.multiSelect, true)
  assert.deepEqual(goal.options.map(option => option.label), GOALS.map(entry => entry.label))
  const materials = questions.find(question => question.id === 'materials')
  assert.equal(materials.options, undefined)
})

test('notices carry the goal choices and fall back sensibly', () => {
  const notice = briefNoticeText(profileFromAnswer({
    answers: [
      { id: 'topic', selected: [], custom: '计算机网络' },
      { id: 'goal', selected: ['实践应用'] },
    ],
  }))
  assert.match(notice, /计算机网络/)
  assert.match(notice, /实践应用/)
  assert.match(notice, /teacher_course/)
  assert.match(briefFallbackText('the form timed out'), /teacher_brief/)
})

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure.name}`)
    console.error(failure.error?.stack ?? failure.error)
  }
  console.error(`\n${passed} passed, ${failures.length} failed`)
  process.exit(1)
}
console.log(`${passed} tests passed`)
