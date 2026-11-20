# dsh-teacher-mode — teacher mode

[中文](README.md) | English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) bundle that adds a **teacher mode** agent preset. Pick the preset for a new session and DSH first interviews you — what you want to learn, why, which materials you already have, your level, and your time or exam constraints — then adapts the depth, the worked examples, and the quizzes to those answers.

It is a bundle, not a prompt template:

- declares one selectable Agent preset (`teacher`), so its tools and teaching protocol exist only in sessions composed from it;
- shows the welcome form before the first model request of the first turn, i.e. before the first tool call;
- ships four tools: `teacher_brief` (learner profile), `teacher_course` (syllabus and progress), `teacher_notes` (class notes), `teacher_quiz` (in-chat quiz with automatic grading);
- writes durable course files into the workspace.

## What it does

| Stage | Behaviour | Guaranteed by |
| --- | --- | --- |
| 0. Interview | Before the first tool call: topic, goals (multi-select), reference materials, level, time/assessment | `agent/pre-step` hook + `ctx.userQuestions` |
| 1. Research | Search authoritative sources with `web_search` / `web_fetch`; **supplied materials win**, and are fetched and checked | Teaching protocol + web tools |
| 2. Teach | Why it matters → intuition → precise definitions → derivation → worked examples → misconceptions → connections | Teaching protocol + per-goal method |
| 3. Notes | One `teacher_notes` call per lesson: explanation, key points, mistakes, sources | `teacher_notes` |
| 4. Quiz | One `teacher_quiz` call per lesson in the GUI question UI, auto-graded; weak points re-taught and re-tested | `teacher_quiz` |
| 5. Progress | `teacher_course` action `complete` checks off a module once quizzes back it up | `teacher_course` |

### How goals change the teaching

The goals selected in the form are recorded in the profile and turn into a concrete method:

| Goal | Examples and quizzes | Explanations |
| --- | --- | --- |
| **Pass an exam** | Basic items in the exam's own shape; minimal derivation | Exam scope, out-of-scope topics, question-type patterns |
| **High score** | Laddered: basic → combined → hard; difficulty and exam-point labels; traps and time budgeting | Method selection, tempting wrong first steps, answer checking |
| **Understand principles** | "Why" and "when does it fail" items; derivations and counterexamples | Motivation and history, full derivation, assumptions and limits |
| **Hands-on application** | Debugging, design, and "what breaks if you change X" items | A runnable experiment, or an open-source project searched, cloned into the workspace, and walked through, then a checkable task |

Several goals combine: the most concrete one picks the examples, the most abstract one sets the derivation depth.

## Tools

- **`teacher_brief`** — `show` reads the profile; `update` records topic, goals, materials, level, and constraints. When the form is unavailable (headless, subagent, or a dismissed card) the tutor asks in prose and records the answers with this tool.
- **`teacher_course`** — `open` writes or rewrites the syllabus and makes it the active course; `status` reports progress and the next module; `complete` checks a module off. Rewriting keeps already-checked modules.
- **`teacher_notes`** — one markdown section per lesson in `notes.md`; a duplicate lesson is refused unless `replace: true`.
- **`teacher_quiz`** — asks a graded quiz through the conversation's question UI and logs it. Single- and multi-select items are graded automatically; open items are marked for the tutor's own judgement. Without an interactive channel the questions are handed back to the tutor instead of failing.

## Course files

Written under the workspace, by default `teacher-notes/<course>/`:

```
teacher-notes/linear-algebra/
├── syllabus.md   # goal, level, module checklist, sources
├── notes.md      # class notes, one section per lesson
└── quizzes.md    # quiz log with scores and wrong answers
```

The learner profile is stored at `.dsh-teacher/<session-id>.json`, so a resumed session is never asked twice. Both directories are configurable.

## Install

This is a standard DSH bundle (`dsh.bundle` + `cordis.patch.yml`): installing it adds one preset and changes no other preset.

Install from GitHub (requires a DSH installation that ships the `dsh plugin` command):

```sh
dsh plugin --profile <profile> add github:reisen0327-sudo/dsh-teacher-mode
```

Alternatively install from the DSH plugins page, or let an agent install it with `plugin_manager` using this repository as the target:

```text
plugin_manager(action: "install_bundle", target: "github:reisen0327-sudo/dsh-teacher-mode")
```

**Restart DSH afterwards.** The desktop profile applies bundle patches only at startup and caches ESM modules by path, so the new preset appears in the new-session picker only after a restart.

Remove it with:

```text
plugin_manager(action: "remove_bundle", target: "dsh-teacher-mode")
```

## Use

1. Start a new session with the **教学模式** (teacher mode) preset.
2. Send the first message.
3. Fill in the welcome form and submit. Teaching starts.
4. Interject freely: "explain that again", "harder questions", "skip this section", "use the MIT 18.06 notes".

Commands: `/teacher status`, `/teacher brief` (re-open the form), `/teacher help`.

Teacher mode is a session preset: to leave it, start a new session with another preset. A session that has already started cannot switch mid-way.

## Configuration

```yaml
- id: teacher-mode
  name: 'dsh-teacher-mode'
  config:
    notesDir: teacher-notes      # workspace-relative course root
    stateDir: .dsh-teacher       # workspace-relative profile root
    maxQuizQuestions: 8          # ceiling for one teacher_quiz
    passRatio: 0.8               # auto-graded pass line
    askOnStart: true             # show the welcome form on the first turn
    briefTimeoutMs: 600000       # how long the form may hold the turn
    # policy: |                  # replace the built-in teaching protocol
```

## Credits and attribution

The teaching loop, the course-file layout (`syllabus.md` / `notes.md` / `quizzes.md`), and the grading rules are ported and adapted from **[dsh-edu](https://github.com/1Vewton/dsh-edu)** (published as `dsh-edu-mode`, by [@1Vewton](https://github.com/1Vewton), MIT License, Copyright (c) 2026 1Vewton). The upstream project defined the `edu_course` / `edu_notes` / `edu_quiz` tools and the whole teaching protocol; this project keeps that design.

Changes made here:

| Dimension | dsh-edu (upstream) | dsh-teacher-mode (this project) |
| --- | --- | --- |
| Entry | `/edu` command toggles a session mode | selecting a **teacher** Agent preset |
| Scope | globally registered tools, gated per session | only sessions of that preset (tools and prompt text live in the preset scope) |
| Learner profile | none | collected by a welcome form in `agent/pre-step` |
| Method adaptation | none | per-goal prescriptions (example difficulty, derivation depth, quiz shape) |
| State storage | custom session-log events | memory + workspace JSON (no undocumented event types) |
| DSH kernel target | written for `0.1.1-rc.2` | rewritten against `0.2.2-rc.5` APIs (`preset` declarations, `defineTool`, `ctx.userQuestions`) |
| Code shape | TypeScript sources + build output | directly runnable ESM modules with pure-function tests |

The upstream MIT licence and copyright notice are kept in [NOTICE](NOTICE). This project is not an official version of dsh-edu and has no affiliation with the upstream maintainer; upstream changes are not synced automatically.

## Development

```sh
node tests/run.mjs   # 22 pure-function tests: paths, rendering, grading, profile parsing
```

Source layout: `lib/index.js` (entry, pre-step form, prompt section, command), `lib/brief.js` (profile + form), `lib/policy.js` (protocol and per-goal method), `lib/grading.js` (pure grading), `lib/course.js` (brief/course/notes tools), `lib/quiz.js` (quiz tool), `lib/paths.js` (pure layout and markdown), `lib/store.js` (ctx.fs access).

## Limitations

- A preset applies to one session; `/teacher` cannot switch a started session in or out of teacher mode.
- Grading covers machine-gradable items only; open questions rely on the tutor's judgement (reference answers are returned with the result).
- The welcome form needs the GUI question UI; in headless or subagent contexts the tutor degrades to asking in prose.
- Notes are grouped by course name, so two courses with the same name are the same course; renaming a course starts a new one.
- Teacher mode does not restrict other tools; the protocol only insists that "making the learner understand" is the deliverable.

## Licence

[MIT](LICENSE)
