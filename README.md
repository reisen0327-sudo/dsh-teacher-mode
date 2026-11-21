# dsh-teacher-mode — 教学模式

中文 | [English](README.en.md)

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/reisen0327-sudo/dsh-teacher-mode)
[![dshfind](https://dshfind.com/api/badge/reisen0327-sudo/dsh-teacher-mode?lang=zh)](https://dshfind.com/zh/plugins/reisen0327-sudo/dsh-teacher-mode?ref=badge)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）加一个**教学模式**预设：新建会话时选择「教学模式」，DSH 会先弹窗问你「想学什么、为什么学、手上有哪些参考资料、什么水平、什么时候考」，再按这些答案调整讲解深度、例题难度和测验形式，真的把一门课教下去。

它不是一个提示词模板，而是一个标准 DSH 组合包（bundle）：

- 声明一个可选的 Agent 预设（`teacher`），所以工具与教学协议只出现在选择该预设的会话里；
- 第一轮模型请求（也就是第一次工具调用）之前弹窗收集**学习目标**与**参考资料**；
- 提供四个工具：`teacher_brief`（学习档案）、`teacher_course`（课程大纲与进度）、`teacher_notes`（课堂笔记）、`teacher_quiz`（对话内问答 + 自动判分）；
- 课程文件落在工作区，跨会话保留进度。

## 它做什么

| 阶段 | 行为 | 由什么保证 |
| --- | --- | --- |
| 0. 采集 | 第一轮工具调用之前弹窗：学习内容、学习目标（可多选）、参考资料、当前基础、时间/考核 | `agent/pre-step` 钩子 + `ctx.userQuestions` |
| 1. 调研 | 用 `web_search` / `web_fetch` 找权威来源；**优先使用你提供的资料**，抓取并核验 | 教学协议 + web 工具 |
| 2. 讲解 | 先讲为什么有用 → 直觉/类比 → 精确定义（先定义符号）→ 推导 → 例题 → 常见误区 → 与前后知识的联系 | 教学协议 + 目标对应的教法 |
| 3. 笔记 | 每讲一次课调用 `teacher_notes`，把讲解、要点、易错点、来源写成 markdown | `teacher_notes` 工具 |
| 4. 出题 | 每讲结束调用 `teacher_quiz`，在 GUI 问答界面做题并自动判分；错题重新讲、重新考 | `teacher_quiz` 工具 |
| 5. 进度 | 模块目标达成后调用 `teacher_course` 打勾，跨会话保留 | `teacher_course` 工具 |

### 学习目标如何改变教法

弹窗里选中的目标会写进学习档案，并生成对应的教学处方（不是「请因材施教」这种空话）：

| 目标 | 例题与测验 | 讲解方式 |
| --- | --- | --- |
| **通过考试** | 基础题为主，按考纲题型；只做必要推导 | 明确考纲范围、排除超纲内容、给题型模板 |
| **取得高分** | 阶梯式：基础 → 综合 → 压轴；标注难度与考点；讲陷阱与时间分配 | 讲方法选择、易错第一步、答案检验 |
| **理解原理** | 侧重「为什么」「什么时候失效」；推导题、反例题 | 从问题动机与历史讲起，完整推导，讲假设与边界 |
| **实践应用** | 调试题、设计题、「改 X 会坏在哪」 | 可运行的最小实验；搜索并下载开源项目到工作区，带读入口文件/核心算法/测试，再布置可验收的动手任务 |

多选时会叠加：用最具体的目标选题材，用最抽象的目标决定推导深度，并在讲解里标出每部分服务于哪个目标。

## 四个工具

- **`teacher_brief`** — `show` 读学习档案；`update` 记录/更新（学习内容、目标、参考资料、水平、时间、补充约束）。弹窗不可用时（headless、子代理、你关掉了卡片），模型会先用文字问你，再用它记录。
- **`teacher_course`** — `open` 建立/改写课程大纲（目标、水平、模块清单、参考来源）并设为当前课程；`status` 报告进度和下一个模块；`complete` 给模块打勾。重写大纲不会丢掉已打勾的模块。
- **`teacher_notes`** — 为某一讲写课堂笔记（正文 + 要点 + 常见误区 + 来源），写入 `notes.md`。同一讲重复写会被拒绝，除非显式 `replace: true`。
- **`teacher_quiz`** — 出题、通过对话内问答组件收答案、判分、写测验记录。选择题自动判分（单选/多选），开放题标记为「需要模型自己判」。没有可交互问答通道时（headless、ACP、子代理）不报错，而是把题目交回模型在对话里问。

## 课程文件

默认写在会话工作区的 `teacher-notes/<课程名>/`：

```
teacher-notes/线性代数/
├── syllabus.md   # 课程目标、水平、模块清单（- [ ] / - [x]）、参考来源
├── notes.md      # 课堂笔记，一讲一节
└── quizzes.md    # 测验记录，一次一节，含得分与错题
```

学习档案（目标、参考资料等）存在工作区的 `.dsh-teacher/<session-id>.json`，所以恢复会话后不会再弹一次窗。两个目录都可以通过配置改。

## 安装

本包是标准 DSH 组合包（`dsh.bundle` + `cordis.patch.yml`），安装后**新增一个预设**，不改动其它预设。

推荐从 GitHub 安装（需要该 DSH 安装带有 `dsh plugin` 命令）：

```sh
dsh plugin --profile <profile> add github:reisen0327-sudo/dsh-teacher-mode
```

也可以在 DSH 的 Web/桌面端插件页安装，或让 agent 用 `plugin_manager` 以本包目录（或 raw 源码目录）为 `target` 安装：

```text
plugin_manager(action: "install_bundle", target: "github:reisen0327-sudo/dsh-teacher-mode")
```

安装后**重启该 profile 的 DSH**（桌面端退出应用再打开）。desktop profile 只在启动时应用组合包 patch，且同一路径的 ESM 模块会被缓存，所以必须重启，新建会话时才会在预设列表里看到「教学模式」。

卸载：

```text
plugin_manager(action: "remove_bundle", target: "dsh-teacher-mode")
```

## 使用

1. 新建会话，预设选「教学模式」。
2. 发出第一条消息（哪怕只说「开始」）。
3. 会弹出一张表单：学习内容、目标、参考资料、当前基础、时间/考核。填完提交，教学开始。
4. 之后可以直接插话：「这块再讲一遍」「出难一点的题」「跳过这节」「用 MIT 18.06 那本教材」。

命令：

| 命令 | 效果 |
| --- | --- |
| `/teacher status` | 查看当前学习档案（目标、参考资料、水平、当前课程） |
| `/teacher brief` | 重新打开采集表单，修改目标或参考资料 |
| `/teacher help` | 说明教学模式是预设而非开关 |

教学模式是**会话预设**：要退出，新建会话时选别的预设（或在空会话里切换预设）。已开始的会话不会中途换预设。

## 配置

`cordis.patch.yml` 里 `teacher-mode` 行的 `config`（插件加载时严格校验，写错会直接报错而不是静默取默认值）：

```yaml
- id: teacher-mode
  name: 'dsh-teacher-mode'
  config:
    notesDir: teacher-notes        # 课程文件根目录（工作区相对路径）
    stateDir: .dsh-teacher         # 学习档案目录（工作区相对路径）
    maxQuizQuestions: 8            # 一次 teacher_quiz 最多几道题
    passRatio: 0.8                 # 自测通过线（自动判分部分的比例）
    askOnStart: true               # 第一轮是否弹窗采集学习档案
    briefTimeoutMs: 600000         # 弹窗最多停留多久（毫秒）后自动放行
    # policy: |                    # 需要时用整段自定义教学协议覆盖内置的
```

## 致谢与引用

本项目的教学循环、课程文件布局（`syllabus.md` / `notes.md` / `quizzes.md`）与判分规则，是在 **[dsh-edu](https://github.com/1Vewton/dsh-edu)**（原插件名 `dsh-edu-mode`，作者 [@1Vewton](https://github.com/1Vewton)，MIT License，Copyright (c) 2026 1Vewton）的基础上移植和改编的。原项目定义了 `edu_course` / `edu_notes` / `edu_quiz` 三个工具与整套教学协议，本项目的对应工具与协议直接沿用了它的设计。

在此基础上，本项目做了这些改动：

| 维度 | dsh-edu（上游） | dsh-teacher-mode（本项目） |
| --- | --- | --- |
| 进入方式 | `/edu` 命令切换会话模式 | 选择「教学模式」Agent 预设 |
| 作用范围 | 全局注册的工具，按会话状态开关 | 仅该预设的会话（工具与协议都在 preset scope） |
| 学习档案例 | 无 | 第一轮 `agent/pre-step` 弹窗采集目标与参考资料 |
| 教法适配 | 无 | 按目标生成具体处方（例题难度、推导深度、测验形式） |
| 教学状态存储 | 会话日志自定义事件 | 内存 + 工作区 JSON（不依赖未公开事件类型） |
| DSH 内核适配 | `0.1.1-rc.2` 时代 | 按 `0.2.2-rc.5` 的 API 重写（`preset` 声明、`defineTool`、`ctx.userQuestions`） |
| 代码形态 | TypeScript 源码 + 构建产物 | 直接可运行的 ESM 模块，附纯函数测试 |

上游的 MIT 许可证与版权声明一并保留在 [NOTICE](NOTICE) 中。本项目不是 dsh-edu 的官方版本，与上游项目没有隶属关系；如果上游更新，本项目不会自动同步。

## 开发

```sh
node tests/run.mjs     # 22 个纯函数测试：路径、渲染、判分、档案解析
```

源码结构：

```
lib/index.js    插件入口：配置校验、pre-step 弹窗、教学协议 section、命令
lib/brief.js    学习档案：内存 + 工作区镜像、采集表单、通知文本
lib/policy.js   教学协议与按目标生成的教法处方
lib/grading.js  纯判分函数（无依赖，便于测试）
lib/course.js   teacher_brief / teacher_course / teacher_notes 工具
lib/quiz.js     teacher_quiz 工具（交互 + 降级路径）
lib/paths.js    课程文件布局与 markdown 渲染（纯函数）
lib/store.js    课程文件读写（走 ctx.fs，受沙箱约束）
cordis.patch.yml  预设声明与插件组成
```

## 限制

- 预设的作用范围是单个会话；`/teacher` 不能把已开始会话切到/切出教学模式。
- 判分只覆盖可机判的题型；开放题依赖模型自己的判断（工具会把参考答案一并返回）。
- 弹窗依赖 GUI 的问答组件；headless/子代理没有人类可问，会走文字降级路径。
- 笔记文件按课程名分目录，同名课程视为同一门课；重命名课程等于另起一门。
- 教学模式不会限制其它工具，模型仍可能被要求做别的任务——协议明确要求它把「讲懂」当作交付物。

## 许可证

[MIT](LICENSE)
