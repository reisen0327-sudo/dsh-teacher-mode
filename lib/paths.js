/**
 * Pure course-file layout and rendering for teacher mode. Nothing here touches
 * the filesystem, the clock, or the plugin context: paths and markdown are
 * computed from arguments so the same functions serve the tools and the tests.
 *
 * Layout written under the workspace-relative notes root:
 *
 * ```text
 * <notesDir>/<course>/
 *   syllabus.md   course goal, module checklist, sources   (teacher_course)
 *   notes.md      the class notes, one section per lesson  (teacher_notes)
 *   quizzes.md    the quiz log, one section per quiz       (teacher_quiz)
 * ```
 */

/** Characters that cannot appear in a Windows path segment. */
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g

/**
 * Turn a human course name into one safe path segment. CJK and other
 * non-ASCII letters are preserved so `线性代数` keeps its name; only
 * separators, reserved characters, and whitespace runs are rewritten.
 *
 * @param {string} raw The user-facing course name.
 * @returns {string} A non-empty, filesystem-safe directory name.
 */
export function slugifyCourse(raw) {
  const slug = String(raw)
    .trim()
    .replace(FORBIDDEN, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
  const clipped = slug.slice(0, 60).replace(/[.\-]+$/g, '')
  return clipped === '' ? 'course' : clipped
}

/**
 * Join path segments with forward slashes, dropping empty ones.
 * @param {...string} segments Path segments.
 * @returns {string} The joined relative path.
 */
function join(...segments) {
  return segments
    .map(segment => String(segment).replace(/^\/+|\/+$/g, ''))
    .filter(segment => segment !== '')
    .join('/')
}

/**
 * Resolve the file layout of one course.
 *
 * @param {string} notesDir Workspace-relative notes root from plugin config.
 * @param {string} course User-facing course name.
 * @returns {{dir: string, syllabus: string, notes: string, quizzes: string}} Every path the course tools write.
 */
export function courseLayout(notesDir, course) {
  const dir = join(notesDir, slugifyCourse(course))
  return {
    dir,
    syllabus: `${dir}/syllabus.md`,
    notes: `${dir}/notes.md`,
    quizzes: `${dir}/quizzes.md`,
  }
}

/**
 * Workspace-relative path of the per-session learner profile file. The state
 * lives outside the course directory so renaming or opening a new course never
 * loses the goals and materials the learner supplied.
 *
 * @param {string} stateDir Workspace-relative state root from plugin config.
 * @param {string} sessionId The owning session id.
 * @returns {string} The workspace-relative JSON path.
 */
export function briefPath(stateDir, sessionId) {
  const safe = String(sessionId).replace(FORBIDDEN, '-').replace(/\s+/g, '-')
  return join(stateDir, `${safe}.json`)
}

/**
 * Render one module checklist line.
 * @param {{id: string, title: string, objectives?: string[]}} module Syllabus module.
 * @param {boolean} done Whether the module is complete.
 * @returns {string} One markdown list item.
 */
function moduleLine(module, done) {
  const objectives = (module.objectives ?? []).map(objective => `   - ${objective}`).join('\n')
  const head = `- [${done ? 'x' : ' '}] ${module.id} · ${module.title}`
  return objectives === '' ? head : `${head}\n${objectives}`
}

/**
 * Render source bullets.
 * @param {{title: string, url?: string}[]} sources Cited sources.
 * @returns {string[]} Markdown bullet lines.
 */
function sourceLines(sources) {
  return sources.map((source) => {
    const url = source.url?.trim()
    return url === undefined || url === '' ? `- ${source.title}` : `- [${source.title}](${url})`
  })
}

/**
 * Render a course syllabus.
 *
 * @param {{course: string, goal?: string, level?: string, modules: Array<{id: string, title: string, objectives?: string[], done?: boolean}>, sources?: Array<{title: string, url?: string}>, date: string}} input Course facts.
 * @returns {string} Markdown for `syllabus.md`.
 */
export function renderSyllabus(input) {
  const lines = [
    `# ${input.course}`,
    '',
    `> Maintained by dsh-teacher-mode · opened ${input.date}`,
    '',
    '## Goal',
    '',
    input.goal?.trim() ? input.goal.trim() : '_Not set yet._',
    '',
    '## Starting level',
    '',
    input.level?.trim() ? input.level.trim() : '_Unknown — ask once, then adapt._',
    '',
    '## Modules',
    '',
    ...(input.modules.length === 0
      ? ['_No modules yet._']
      : input.modules.map(module => moduleLine(module, module.done === true))),
    '',
  ]
  if ((input.sources ?? []).length > 0) {
    lines.push('## Sources', '', ...sourceLines(input.sources ?? []), '')
  }
  lines.push(
    '## Progress',
    '',
    'A module is checked off by `teacher_course` action `complete` once its quizzes back the claim.',
    '',
  )
  return lines.join('\n')
}

/**
 * Render one lesson section of the class notes.
 *
 * @param {{lesson: string, body: string, keyPoints?: string[], misconceptions?: string[], sources?: Array<{title: string, url?: string}>, date: string}} input Lesson facts.
 * @returns {string} Markdown appended to `notes.md`.
 */
export function renderNoteSection(input) {
  const lines = [`## ${input.lesson}`, '', `> ${input.date}`, '', input.body.trim(), '']
  const section = (title, items) => {
    if (items === undefined || items.length === 0) return
    lines.push(`### ${title}`, '', ...items.map(item => `- ${item}`), '')
  }
  section('Key points', input.keyPoints)
  section('Common misconceptions', input.misconceptions)
  if ((input.sources ?? []).length > 0) {
    lines.push('### Sources', '', ...sourceLines(input.sources ?? []), '')
  }
  return lines.join('\n')
}

/**
 * Render one quiz-log section.
 *
 * @param {{topic: string, score: number | undefined, correct: number, gradable: number, passed: boolean | undefined, entries: Array<{question: string, verdict: string, responded: string, expected?: string}>, note?: string, date: string}} input Quiz facts.
 * @returns {string} Markdown appended to `quizzes.md`.
 */
export function renderQuizSection(input) {
  const percent = input.score === undefined ? 'n/a' : `${Math.round(input.score * 100)}%`
  const verdict = input.passed === undefined ? '' : input.passed ? ' · passed' : ' · needs review'
  const lines = [
    `## ${input.topic} — ${input.correct}/${input.gradable} (${percent})${verdict}`,
    '',
    `> ${input.date}`,
    '',
    ...input.entries.map((entry) => {
      const mark = entry.verdict === 'correct' ? '✅' : entry.verdict === 'partial' ? '🟡' : entry.verdict === 'skipped' ? '⏭️' : '❌'
      const head = `- ${mark} ${entry.question}`
      const answered = `  - answered: ${entry.responded}`
      const expected = entry.verdict === 'correct' || entry.expected === undefined
        ? []
        : [`  - expected: ${entry.expected}`]
      return [head, answered, ...expected].join('\n')
    }),
    '',
  ]
  if (input.note?.trim()) lines.push(`> ${input.note.trim()}`, '')
  return lines.join('\n')
}

/**
 * Check or uncheck one module in an existing syllabus. Only the checkbox of a
 * line whose identifier matches exactly is rewritten; everything else is
 * preserved byte for byte, so a hand-edited syllabus survives.
 *
 * @param {string} markdown Current syllabus markdown.
 * @param {string} moduleId The module identifier to toggle.
 * @param {boolean} done Target checkbox state.
 * @returns {{text: string, changed: boolean}} The new markdown plus whether a matching line was found.
 */
export function toggleModule(markdown, moduleId, done) {
  const escaped = String(moduleId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^- \\[[ xX]\\] ${escaped}(?=\\s|$)`, 'm')
  if (!pattern.test(markdown)) return { text: markdown, changed: false }
  const text = markdown.replace(pattern, `- [${done ? 'x' : ' '}] ${moduleId}`)
  return { text, changed: true }
}

/**
 * Read the module checklist out of a syllabus, so `status` can report progress
 * without a second bookkeeping file.
 *
 * @param {string} markdown Current syllabus markdown.
 * @returns {Array<{id: string, title: string, done: boolean}>} One entry per module line, in file order.
 */
export function parseModules(markdown) {
  const modules = []
  for (const line of markdown.split('\n')) {
    const match = /^- \[([ xX])\] ([^·\s]+) · (.+?)\s*$/.exec(line)
    if (match === null) continue
    modules.push({ id: match[2], title: match[3], done: match[1].toLowerCase() === 'x' })
  }
  return modules
}

/**
 * Append a markdown section to a document, or replace the existing section with
 * the same `##` heading. A second write for the same lesson is reported as a
 * duplicate instead of silently stacking two copies of it.
 *
 * @param {string} document Current document text (may be empty).
 * @param {string} heading Section heading text, without the leading `## `.
 * @param {string} section The rendered section, heading included.
 * @param {boolean} replace Whether an existing same-heading section may be replaced.
 * @returns {{kind: 'duplicate'} | {kind: 'written', text: string, action: 'appended' | 'replaced'}} The new document, or a duplicate verdict.
 */
export function upsertSection(document, heading, section, replace) {
  const lines = document.split('\n')
  const start = lines.findIndex(line => line.trimEnd() === `## ${heading}`)
  if (start < 0) {
    const head = document.trim() === '' ? '' : `${document.replace(/\n+$/, '')}\n\n`
    return { kind: 'written', text: `${head}${section.replace(/\n+$/, '')}\n`, action: 'appended' }
  }
  if (!replace) return { kind: 'duplicate' }
  let end = start + 1
  while (end < lines.length && !/^##\s/.test(lines[end])) end++
  const merged = [...lines.slice(0, start), ...section.replace(/\n+$/, '').split('\n'), '', ...lines.slice(end)]
  return { kind: 'written', text: merged.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n'), action: 'replaced' }
}

/**
 * Local `YYYY-MM-DD` stamp for the given instant.
 *
 * @param {Date} now The instant to stamp.
 * @returns {string} A date string in the machine's local time zone.
 */
export function stamp(now) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Render a module identifier and title for humans.
 * @param {{id: string, title: string}} module The module.
 * @returns {string} `id · title`.
 */
export function moduleLabel(module) {
  return `${module.id} · ${module.title}`
}
