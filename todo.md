# slides-it — Phase 1 Todo

## 决策记录

### 产品定位
- 目标用户：不会用 OpenCode 的普通用户 + 开发者（两类都要）
- 核心价值：给 OpenCode 生态增加应用场景；让普通用户无需懂 OpenCode 就能用 AI 生成 HTML 演示文稿

### 架构决策
- AI 引擎：直接复用 OpenCode Server（`opencode serve`），不自建 agent loop
- System prompt 注入：**通过 `POST /session/:id/prompt_async` 的 `system` 字段**传递（OpenCode Server 原生支持）
  - 前端 App 初始化时通过 `GET /api/template/<name>/skill` 加载 default template skill 并缓存为 React state
  - Template 切换时：重新调用接口拉取新 template skill，缓存更新后下一条消息即生效，零延迟
  - 后端 `GET /api/template/{name}/skill` 返回拼接好的 `core SKILL.md + template SKILL.md`
  - 不写入 `~/.config/opencode/AGENTS.md`，零文件副作用，不污染用户全局 opencode 配置
- 前端技术栈：React 19 + TypeScript + Tailwind v4 + Vite，参考 `chat_design.md`
- 布局：WorkspaceSelector（第一屏）→ 三栏主界面（FileTree + Chat + PreviewPanel 可折叠）
- 产品流程：打开 slides-it → 选择 workspace folder → 确认后启动 opencode serve → 进入聊天
- 安装方式：`curl | sh` 脚本，自动安装 opencode + 下载 slides-it 预编译二进制
- 分发方式：**PyInstaller** 打包成独立可执行文件，上传到 GitHub Releases（无需用户有 Python）
- Python CLI：FastAPI server（port 3000）提供目录浏览 API + 管理 opencode 进程

### Template 系统决策
- Template 本质：一个包含 `TEMPLATE.md` + `SKILL.md` 的目录，SKILL.md 描述样式风格注入给 AI
- Template 存储：`~/.config/slides-it/templates/<name>/`
- Template 来源：不限于 GitHub，支持任意来源
  ```bash
  slides-it template install dark-neon              # 从官方 registry
  slides-it template install https://example.com/t.zip  # 任意 URL
  slides-it template install github:user/repo       # GitHub repo
  slides-it template install ./my-local-template    # 本地目录（开发用）
  ```
- Registry：中心化 JSON 文件（托管在 slides-it 主 repo），维护官方/社区 template 目录
- Template 应用：Web UI TitleBar 下拉切换；前端通过 `system` 字段在每条消息中传递 skill 内容
- 内置 default template：随 slides-it 安装，从 `html-template.md` 提炼

---

## 进度总览

| Milestone | 状态 |
|---|---|
| M0 — Template 系统基础 | ✅ 完成 |
| M1 — SKILL.md 核心 AI 能力 | ⚠️ 编写完成，待端到端测试 |
| M2 — 前端 ChatPanel | ✅ 完成 |
| M3 — 预览面板 & 布局重构 | ✅ 完成 |
| M4 — Python CLI & Server | ✅ 完成 |
| UI — Claude 风格浅色主题 | ✅ 完成 |
| M4.1 — 进程生命周期 & 端口清理 | ✅ 完成 |
| M4.2 — FileTree 文件上传 | ✅ 完成 |
| M4.3 — Provider Settings | ✅ 完成 |
| M4.4 — UI 体验优化 | ✅ 完成 |
| M4.5 — Mode 切换 & @ 文件引用 | ✅ 完成 |
| M6 — System prompt via API + Template 实时切换 | ✅ 完成 |
| M7 — Model pill 移至 input box 下方 | ✅ 完成 |
| M8 — 内置 minimal template | ✅ 完成 |
| M9 — Template 管理 Modal | ✅ 完成 |
| M10 — Agent 可见性（Tool/Thinking 展示） | ✅ 完成 |
| M11 — AskUserQuestion 问卷交互 | ✅ 完成 |
| M5 — 打包 & 分发 | ✅ 完成 |
| M19 — SKILL/DESIGN 职责分离 & 演讲结构规范 | ✅ 完成 |
| M20 — Industry（行业）系统 | ✅ 完成 |
| M21 — Replay（无限上下文） | ✅ 完成 |
| M22 — Sub-agent 可见性（Explore/General Task） | ✅ 完成 |
| M23 — 文档提取（PDF/Excel/Word/PPT/CSV） | ✅ 完成 |
| M24 — 统一文件引用：前端只发路径 | ✅ 完成 |
| M25 — 图片压缩集成到文档提取 API | ✅ 完成 |

---

## M21 — Replay（无限上下文）✅

当对话上下文超出 LLM 窗口限制时，自动 compact 当前 session 并在新 session 中继续，用户无感。
重启 slides-it 后，自动将上一轮对话注入新 session，用户可无缝继续。

### 核心流程
1. 检测 `session.error` 中的 context overflow 错误（正则模式匹配）
2. 调用 OpenCode `POST /session/:id/summarize` 生成摘要
3. 读取摘要文本（从 summarize 生成的 compaction + assistant 消息中提取）
4. 创建新的子 session（`parentID` 指向旧 session）
5. 通过 `noReply: true` 将摘要注入新 session 作为上下文
6. 前端切换到新 session，重发失败的用户消息
7. 重启时通过 `injectContext()` 将上一轮对话注入新 OpenCode session

### 持久化设计
每个 session 文件只存自己的消息，通过 `parent` 字段建立链表：

```
.slides-it/
├── current                          ← "ses_C"
├── session-ses_A.json               ← { messages: [A的消息] }
├── session-ses_B.json               ← { parent: "ses_A", messages: [B的消息] }
├── session-ses_C.json               ← { parent: "ses_B", messages: [C的消息] }
```

- `GET /api/session` 递归加载 parent 链，返回完整消息历史 + 当前 session 自己的消息
- `PUT /api/session` 只写入当前 session 的消息，保留 parent 链接
- 重启时 `initSession()` 用 `recent_messages`（当前 session 自己的消息）做 `injectContext`

### 文件变更
- [x] `slides_it/server.py`：
  - 新增 `POST /api/replay` 和 `POST /api/replay/check` 端点
  - `SessionRequest` 加 `parent_session_id` 字段
  - `get_session()` 递归加载 parent 链，返回 `messages` + `recent_messages`
  - `save_session()` 支持 `parent` 字段，保留链式关系
  - `_is_context_overflow()` — 错误消息模式匹配
  - `_opencode_get()` / `_opencode_post()` — OpenCode API HTTP 辅助函数
  - `_do_replay()` — 完整的 summarize → create → inject 编排
- [x] `frontend/src/lib/opencode-api.ts`：新增 `injectContext()` — `noReply: true` 上下文注入
- [x] `frontend/src/lib/slides-server-api.ts`：
  - `saveSession()` 新增 `parentSessionId` 参数
  - `getSession()` 返回类型加 `recent_messages`
  - 新增 `postReplay()` 和 `checkReplayOverflow()`
- [x] `frontend/src/lib/typewriter.ts`：`ChatMessage` 加 `'system'` role 和 `compact` 标识
- [x] `frontend/src/components/ChatPanel.tsx`：
  - `sessionStartIdxRef` — 追踪当前 session 消息在数组中的起始位置
  - `parentSessionIdRef` — 追踪 parent session 关系
  - `persistCurrentSession()` / `currentSessionMessages()` — 只保存当前 session 的消息
  - `performReplay()` — 分离保存逻辑，旧 session 保存自己的消息，新 session 只存新消息 + parent
  - `initSession()` — 用 `recent_messages` 做 `injectContext`，去掉 `findLastIndex(compact)`
  - `handleNewChat()` — 重置 replay 状态
  - `MessageBubble` 新增 `'system'` role 渲染（居中分隔线样式）

### API 端点
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/replay` | 执行 replay：compact 当前 session → 创建新 session → 注入摘要 |
| `POST` | `/api/replay/check` | 检测错误消息是否为 context overflow |
| `GET` | `/api/session` | 递归加载 parent 链，返回 `messages` + `recent_messages` |
| `PUT` | `/api/session` | 保存当前 session 消息 + parent 链接 |

---

## M0 — Template 系统基础 ✅

- [x] 设计并编写 `TEMPLATE.md` 格式规范
- [x] 编写内置 default template（`slides_it/templates/default/`）
- [x] 编写 `slides_it/templates.py`：list / install / remove / activate / write_rules / cleanup_rules
- [x] 设计 `registry.json` 格式，创建初始版本
- [x] 实现 `slides-it template` 子命令（list / search / install / remove / activate）

## M1 — SKILL.md（核心 AI 能力）⚠️

- [x] 编写 `slides_it/skill/SKILL.md`（对话流程层）
- [x] 编写 `slides_it/templates/default/SKILL.md`（default 样式层）
- [ ] **端到端测试**：`uv run slides-it` → 选 workspace → 聊天生成 slides → 验证 HTML 质量
- [ ] 迭代 prompt，直到生成质量满意

## M2 — 前端基础（ChatPanel）✅

- [x] 初始化 `frontend/`（Vite + React 19 + TypeScript + Tailwind v4）
- [x] 实现 `TitleBar`（在线状态、版本号、template 切换下拉、New Chat 按钮）
- [x] 实现 `ChatPanel`（按 `chat_design.md`）
  - [x] `MessageBubble`（user / assistant / streaming / tool blocks）
  - [x] `ThinkingDots` 动画
  - [x] `ChatInput`（textarea、IME 修复、自动高度）
  - [x] SSE 连接（`/event`）+ 打字机引擎
  - [x] Abort 流程

## M3 — 预览面板 & 布局重构 ✅

- [x] `WorkspaceSelector.tsx`（目录树浏览器，从 home 开始，懒加载子目录，快捷入口，轮询等待 opencode 就绪）
- [x] `FileTree.tsx`（按 `chat_design.md §9`：懒加载、Live Sync polling、文件图标颜色）
- [x] `PreviewPanel.tsx`（iframe blob URL + 下载 + 刷新 + 折叠到 32px / 展开到 45%）
- [x] `App.tsx`：`page` state（workspace / chat），三栏布局（FileTree + Chat + PreviewPanel）

## M4 — Python CLI & Server ✅

- [x] `slides_it/server.py`（FastAPI）
  - [x] `GET /api/dirs?path=` — 列子目录（懒加载，权限安全）
  - [x] `POST /api/start` — 写入 AGENTS.md + 启动 `opencode serve --cwd <dir>`
  - [x] `GET /api/status` — opencode 健康检查
  - [x] lifespan：退出时 terminate opencode + cleanup AGENTS.md
- [x] `slides_it/cli.py`
  - [x] 检测 opencode 是否已安装
  - [x] 启动 FastAPI server（port 3000）+ 延迟打开浏览器
  - [x] SIGINT/SIGTERM → `_cleanup()` → `cleanup_rules()`
- [x] `pyproject.toml`：入口 `slides_it.cli:main` ✓

### 开发模式

- Vite dev server：port 5173，`/api/*` 通过 proxy 转发到 FastAPI（port 3000）
- `slides-server-api.ts` 使用相对路径 `/api/...`，开发和生产环境通用
- 启动方式：
  ```bash
  # Terminal 1
  uv run python -c "from slides_it.server import run; run(port=3000)"
  # Terminal 2
  cd frontend && npm run dev   # → http://localhost:5173
  ```

## UI — Claude 风格浅色主题 ✅

- [x] 建立 CSS 变量系统（`--bg-app`、`--bg-sidebar`、`--bg-surface`、`--bg-user-msg`、`--border`、`--text-*`、`--btn-send` 等暖色调变量）
- [x] 字体：`Söhne, ui-sans-serif`（Claude 同款无衬线字体栈）
- [x] `index.css`：`.chat-markdown` 全部改为浅色版本，highlight.js 切换为 `github.css`
- [x] `TitleBar`：白色背景，暖灰文字，中性色 dropdown
- [x] `ChatPanel`：用户消息改为米色气泡（右对齐，无边框），发送按钮深色圆形，输入框白色带阴影
- [x] `FileTree`：暖灰侧边栏背景，hover 用暖色
- [x] `WorkspaceSelector`：白色卡片，深色 Open 按钮，暖灰分隔线
- [x] `PreviewPanel`：暖白背景，浅色工具栏，中性 Download 按钮
- [x] `ThinkingDots` / `ToolBlock`：适配浅色主题
- [x] `MarkdownRenderer`：切换 `github.css`（浅色高亮）

## M4.1 — 进程生命周期 & 端口清理 ✅

- [x] `slides_it/server.py`：新增 `POST /api/shutdown` endpoint（收到后 SIGTERM 自己）
- [x] `slides_it/cli.py`：新增 `_free_port(port)` 函数，启动前自动 kill 占用 3000 端口的残留进程
- [x] `frontend/src/App.tsx`：`useEffect` 注册 `beforeunload` → `navigator.sendBeacon('/api/shutdown')`

## M4.2 — FileTree 文件上传 ✅

- [x] `PreviewPanel.tsx`：默认收起（`collapsed` 初始值改为 `true`，有新 HTML 时仍自动展开）
- [x] `slides_it/server.py`：新增 `POST /api/upload`（multipart，写入 workspace 目录）
- [x] `frontend/src/lib/slides-server-api.ts`：新增 `uploadFiles(files, targetDir)` 函数
- [x] `frontend/src/components/FileTree.tsx`：整体 drop zone（dragover 高亮 + drop 上传）+ 顶部上传按钮

## M4.3 — Provider Settings ✅

- [x] `slides_it/templates.py`：新增 `get_settings()` / `save_settings()`
- [x] `slides_it/server.py`：新增 `GET /api/settings`、`PUT /api/settings`，辅助函数 `_write_auth_json` / `_write_opencode_json`；`start_workspace` 启动前写入 workspace `opencode.json`
- [x] `frontend/src/lib/slides-server-api.ts`：新增 `getSettings()` / `saveSettings()`
- [x] `frontend/src/components/SettingsModal.tsx`：新组件（provider / apiKey / baseURL / customModel）
- [x] `frontend/src/components/TitleBar.tsx`：右侧加齿轮按钮
- [x] `frontend/src/components/WorkspaceSelector.tsx`：右上角加齿轮按钮
- [x] `frontend/src/App.tsx`：`settingsOpen` state + `<SettingsModal>`

## M4.4 — UI 体验优化 ✅

- [x] `ChatPanel.tsx`：空状态居中布局，`slides-it` 像素风 logo（Press Start 2P，0.8rem）
- [x] `ChatPanel.tsx`：用户气泡恢复左对齐（保留米色背景）
- [x] `ChatPanel.tsx`：`session.error` 事件处理，错误显示在 agent 气泡里
- [x] `PreviewPanel.tsx`：默认收起；删除 `setInterval` 自动轮询，不再持续刷新
- [x] `FileTree.tsx`：改用 `GET /api/ls`，显示目录和文件（不再依赖 opencode `/file` 接口）
- [x] `slides_it/server.py`：新增 `GET /api/ls`（目录+文件，过滤 `.git`/`.vscode` 等噪音）
- [x] `slides_it/server.py`：`start_workspace` 自动创建 `.slides-it/` 目录
- [x] `index.html`：添加 Press Start 2P 字体（Google Fonts）
- [x] Model 切换：`GET /api/models` + `PUT /api/model`，input 框下方 model pill + 下拉

## M4.5 — Mode 切换 & @ 文件引用 ✅

- [x] `opencode-api.ts`：`sendPrompt` 加 `agent`（plan/build）+ `fileParts` 参数
- [x] `opencode-api.ts`：新增 `findFiles(query)`（`/find/file` 返回 `string[]`，转换为 `{path,name}[]`）
- [x] `opencode-api.ts`：新增 `getFileContent(path)`、`fileToFilePart(path)`、`guessMime()`
- [x] `AtPopover.tsx`：新建，文件搜索弹窗（debounce 120ms、↑↓/Enter/Esc 键盘导航）
- [x] `ChatPanel.tsx`：`currentMode` state，Tab 键切换 build/plan，mode pill 显示在输入框底部
- [x] `ChatPanel.tsx`：`@` 检测触发 AtPopover，选中后替换文本 + 显示引用徽章
- [x] `ChatPanel.tsx`：发送时读取 @ 引用文件内容，编码为 base64 data URI，以 `file` part 发送

## M6 — System prompt via API + Template 实时切换 ✅

- [x] `slides_it/templates.py`：将 `_build_prompt()` 重命名为 `build_prompt()`（公开），移除 `write_rules()` / `cleanup_rules()` 方法
- [x] `slides_it/server.py`：新增 `GET /api/template/{name}/skill` — 返回 `{ skill: str }`；移除 `POST /api/start` 中的 `write_rules()` 调用；移除 lifespan 中的 `cleanup_rules()` 调用
- [x] `slides_it/cli.py`：移除 `_cleanup()` 中的 `cleanup_rules()` 调用；移除 `TemplateManager` import
- [x] `frontend/src/lib/slides-server-api.ts`：新增 `getTemplateSkill(name)` → `GET /api/template/:name/skill`
- [x] `frontend/src/lib/opencode-api.ts`：`sendPrompt` 加 `system?: string` 参数，写入 body
- [x] `frontend/src/App.tsx`：新增 `activeSkill` state；`handleWorkspaceReady` 时加载 default skill；`onTemplateChange` → `handleTemplateChange` 异步加载新 skill；将 `activeSkill` 传给 `<ChatPanel>`
- [x] `frontend/src/components/ChatPanel.tsx`：props 加 `activeSkill?: string`；`handleSend` 里将 `activeSkill` 传给 `sendPrompt`

## M7 — Model pill 移至 input box 下方 ✅

- [x] `frontend/src/components/ChatPanel.tsx`：聊天状态下，从顶部 header 移除 model pill，统一放在 input box 下方（与空状态一致）；顶部 header 仅保留 "New Chat" 按钮

## M8 — 内置 minimal template ✅

- [x] `slides_it/templates/minimal/TEMPLATE.md`：元数据（name=minimal, description, author, version）
- [x] `slides_it/templates/minimal/SKILL.md`：从 slides-it 前端设计语言（暖白色、DM Serif Display + DM Sans、极简）提炼的 AI 视觉风格指令
- [x] `slides_it/templates/minimal/preview.html`：5 张完整示例幻灯片，体现 minimal 风格（serif 标题、暖白背景、纸张质感）
- [x] `slides_it/templates/default/preview.html`：5 张示例幻灯片，体现 default 深色 indigo/cyan 风格

## M9 — Template 管理 Modal ✅

- [x] `slides_it/server.py`：新增 `TemplateEntry` / `InstallTemplateRequest` Pydantic 模型；新增 5 个接口：`GET /api/templates`、`GET /api/template/{name}/preview`、`POST /api/templates/install`、`DELETE /api/templates/{name}`、`PUT /api/templates/{name}/activate`
- [x] `frontend/src/lib/slides-server-api.ts`：新增 `getTemplatePreview()`、`listTemplates()`、`installTemplate()`、`removeTemplate()`、`activateTemplate()` 及对应类型
- [x] `frontend/src/components/TemplatesModal.tsx`：新建组件，左列表（显示 active/builtin 标记）+ 右 iframe 预览 + URL 安装框 + 激活/删除操作
- [x] `frontend/src/components/TitleBar.tsx`：template dropdown 改为动态从 API 加载列表；底部加分隔线 + "Manage templates…" 按钮，触发 `onTemplatesManage` 回调
- [x] `frontend/src/App.tsx`：新增 `templatesOpen` state；集成 `<TemplatesModal>`；modal 激活 template 后调用 `handleTemplateChange` 同步 skill

## M13 — Bug 修复（2026-03-26）✅

### 高严重性（功能失效）
- [x] **BUG-02** `cli.py`：删除重复的 `mount_frontend()` 调用，只由 `server.py:run()` 内部 mount 一次，修复启动后立即退出的问题
- [x] **BUG-05** `server.py`：`asyncio.get_event_loop()` → `asyncio.get_running_loop()`，修复 Python 3.12+ 下 `/api/shutdown` 崩溃
- [x] **BUG-03** `ChatPanel.tsx`：`detectHtmlFile()` 从调用不存在的 `/file/status` 改为调用 `findFiles('.html', 20)`，修复 AI 生成 HTML 后预览不自动刷新

### 中等严重性（用户体验）
- [x] **BUG-07** `WorkspaceSelector.tsx`：`onReady` 成功路径下补 `setStarting(false)`，按钮不再卡死
- [x] **BUG-20** `WorkspaceSelector.tsx`：polling 加 30 秒超时，超时后重置状态并显示错误提示
- [x] **BUG-11** `QuestionBlock.tsx`：`handleSubmit` 加 `try/finally`，`onReply` 失败时 `submitting` 正确重置；`onReply` prop 类型改为 `Promise<void> | void`
- [x] **ISSUE-15** `server.py`：读 `opencode.json` 时先尝试标准 JSON，失败才剥注释，且只剥行首 `//`，`https://` 等 URL 不再被破坏
- [x] **ISSUE-16** `MarkdownRenderer.tsx`：移除 `rehypeRaw`，AI 内容不再能注入原始 HTML/XSS
- [x] **ISSUE-17** `PreviewPanel.tsx`：iframe sandbox 移除 `allow-same-origin`，隔离 AI 生成内容与父页面

### 低严重性（代码质量）
- [x] **ISSUE-13** `cli.py`：`from typing_extensions import Annotated` → `from typing import Annotated`（Python 3.9+ 内置）


---

## M5 — 打包 & 分发 ✅

- [x] 编写 `build.sh`（PyInstaller `--onefile`，打包 `slides_it/` 数据文件 + `frontend/dist/`；含 `_resource_path()` 冻结路径修复）
- [x] GitHub Actions `release.yml`
  - [x] 触发：push tag `v*`
  - [x] 矩阵：macOS arm64 / macOS x86_64 / Linux x86_64
  - [x] 产物上传到 GitHub Releases
- [x] 编写 `install.sh`
  - [x] 检测平台和架构
  - [x] 检测并安装 opencode（`curl -fsSL https://opencode.ai/install | bash`）
  - [x] 从 GitHub Releases 下载对应平台二进制
  - [x] 安装到 `~/.local/bin/` 并加入 PATH
- [x] `cli.py`：新增 `--version / -V` flag，读取 `importlib.metadata.version("slides-it")`；改进 `--help` 说明文字
- [x] `pyproject.toml`：版本升至 `1.0.0`
- [ ] 端到端测试：`curl install` → `slides-it` → 生成 slides 完整流程验证（需 v1.0.0 tag 推送后执行）

---

## M18 — Release 端到端测试 & CI

**背景：** v1.0.0 上线后发现打包二进制完全不执行（`--help`/`--version` 无输出），根因是 `cli.py` 缺少 `if __name__ == "__main__"` 且 `main()` 定义在所有 `@app.command` 之前。已在 v1.0.1 修复。

**教训：** 需要对 release 产物本身做冒烟测试，不能只测源码。

### 决策
- 在 `.github/workflows/` 添加 `release-test.yml`，每次 release 发布后触发
- 覆盖平台：macOS arm64 / macOS x86_64 / Linux x86_64（与 build 矩阵一致）

### 测试要覆盖的内容

**1. CLI 基础验证（打包产物）**
- `slides-it --version` → 输出正确版本号，且与 release tag 一致，非空、非 `unknown`
- `slides-it --help` → 输出 usage，包含 `stop`、`upgrade`、`template` 子命令
- `slides-it stop --help` → 正常输出
- `slides-it upgrade --help` → 正常输出
- `slides-it template --help` → 正常输出
- `slides-it template list` → 正常输出（至少有 default template）

**2. 安装流程验证**
- `curl -fsSL install.sh | bash` 完整跑通
- 安装后 `slides-it --version` 版本号与 release tag 一致

**3. 服务启动 smoke test**
- `slides-it &` 后等 3 秒
- `curl -f http://localhost:3000/` → HTTP 200
- `slides-it stop` → 进程退出

**4. 版本一致性检查（构建时）**
- `pyproject.toml` version == `slides_it/__init__.py __version__` == release tag

### 任务清单
- [ ] `.github/workflows/release-test.yml`：release published 触发，矩阵覆盖三平台，跑上述全部检查
- [ ] `build.sh`：构建前加版本一致性断言（pyproject.toml vs __init__.py）
- [ ] README / AGENTS.md：记录"release 前必须本地跑 `./dist/slides-it --version` 验证"

---

## M14 — Template Switcher 移到 Input 区域 + 切换即触发 Agent ✅

**目标：** 把 template 切换从 TitleBar 移到 input box 下方，切换后立即发消息让 agent 主动应用新样式。

### 决策
- Template pill 放在 input 框底部，位于 mode pill 左侧、model pill 左侧（同一行）
- 切换 template 后立即自动发送消息给 agent（如 `"I've switched to the minimal template. Please use this style for all future slide generation."`），让 agent 在同一 session 中立即感知

### 任务清单
  - [x] `TitleBar.tsx`：移除 template dropdown（保留 status dot、版本、标题、settings gear）
- [x] `App.tsx`：将 `activeTemplate` 和 `onTemplateChange` 作为 props 传给 `ChatPanel`（目前只传 `activeSkill`）
- [x] `ChatPanel.tsx`：
  - [x] 新增 `activeTemplate` + `onTemplateChange` props
  - [x] input 框底部 pill 行：在 mode pill 左侧插入 template pill（动态从 `GET /api/templates` 加载列表）
  - [x] template pill 点击 → 下拉选择 → 调用 `onTemplateChange(name)` 更新 skill → 立即调用 `handleSend` 发送一条固定切换提示消息

---

## M15 — Session 对话持久化（`.slides-it/session.json`）✅

**目标：** 用户重启 slides-it 后，选择同一 workspace 时自动恢复上次对话历史并还原预览。

### 决策
- 只保留最近一次 session（`session.json` 单条记录）
- 恢复 session 后，同时运行 `detectHtmlFile()` 还原预览面板

### 任务清单
- [x] `server.py`：
  - [x] 新增 `GET /api/session` → 读取 `<workspace>/.slides-it/session.json`，返回 `{ session_id: str | null }`
  - [x] 新增 `PUT /api/session` → 接收 `{ session_id: str }`，写入 `<workspace>/.slides-it/session.json`
- [x] `slides-server-api.ts`：新增 `getSession()` / `saveSession(id)` 函数
- [x] `ChatPanel.tsx`：
  - [x] init 流程改为：先调 `GET /api/session`
    - 若有保存的 session ID → 调 `GET /session/:id/message`（OpenCode API）拉取历史消息
    - 若消息拉取成功 → 重建 `ChatMessage[]` state，复用该 session ID（不创建新 session）
    - 若失败（session 已过期）→ 回退到创建新 session
    - 若无保存的 ID → 创建新 session
  - [x] 新 session 创建后立即调 `PUT /api/session` 保存 ID
  - [x] 恢复历史消息后立即调用 `detectHtmlFile()` 还原预览面板
  - [x] 消息重建：将 OpenCode `MessageWithParts` 映射到 `ChatMessage[]`（text parts → text，tool parts → tools[]，reasoning → thinking）
- [x] `opencode-api.ts`：确认 `getMessages(sessionId)` 接口覆盖消息重建所需字段（已有，核查 part.state 结构）

---

## M16 — FileTree 点击 HTML 文件 → 预览面板 ✅

**目标：** 用户在 FileTree 点击任意 `.html` 文件，预览面板立即加载该文件。

### 分析
`FileTree.tsx` 已有 `onFileClick(path)` prop 回调，`App.tsx` 当前需将其接入 `setPreviewFile`。

### 任务清单
- [x] `App.tsx`：`FileTree` 的 `onFileClick` 回调中，判断 `path.endsWith('.html')`，若是则调 `setPreviewFile(path)`（已有此 state，目前未接 FileTree 点击事件）

---

## M17 — SKILL.md：生成的 slides 写入 `slides/` 子目录 ✅

**目标：** Agent 自动在 workspace 创建 `slides/` 目录，所有生成的 HTML 放入其中，保持 workspace 根目录整洁。

### 任务清单
- [x] `slides_it/skill/SKILL.md`：
  - [x] Phase 2 — Generate：将 "write to cwd as `<topic-slug>.html`" 改为 "create `slides/` directory if it doesn't exist, write to `slides/<topic-slug>.html`"
  - [x] Phase 3 — Iterate：更新文件名示例为 `slides/<topic-slug>.html`
  - [x] File Naming 表格：示例路径改为 `slides/ai-in-healthcare.html` 等

---

## M10 — Agent 可见性（Tool/Thinking 展示）✅

- [x] `typewriter.ts`：`ToolEntry` 加 `input`/`output`/`error`/`title` 字段；`ChatMessage` 加 `thinking` 字段
- [x] `ChatPanel.tsx`：`message.part.updated` 从 `part.state` 提取完整 tool 状态（input/output/error/title/status）；reasoning delta 写入 `thinking` 字段；追踪 `runningTool` state，`session.idle`/abort/newChat 时清空
- [x] `ToolBlock.tsx`：重写为可折叠卡片；默认折叠显示工具名+input摘要+状态；展开后显示完整 input JSON + output/error 内容（各自限高滚动）
- [x] `ThinkingDots.tsx`：加 `toolName` prop；有 running tool 时显示旋转图标 + 友好工具名（如 "Reading file…"）；无 tool 时保持原 bouncing dots
- [x] `ChatPanel.tsx MessageBubble`：加 Thinking 折叠块（默认收起，点击展开完整 reasoning 文本）；tools 调用时不显示 ThinkingDots（避免重复）

## M11 — AskUserQuestion 问卷交互 ✅

- [x] `opencode-api.ts`：新增 `replyQuestion(requestId, answers)` → `POST /question/:id/reply`；`rejectQuestion(requestId)` → `POST /question/:id/reject`
- [x] `typewriter.ts`：新增 `QuestionRequest`、`QuestionInfo`、`QuestionOption` 类型；`ChatMessage` 加 `question`（待回答）和 `questionAnswered`（已回答摘要）字段
- [x] `QuestionBlock.tsx`（新建）：问卷渲染组件，支持单选（radio）/多选（checkbox）/custom 文本输入；submit 时一次性提交所有问题的答案；answered 模式下显示只读摘要
- [x] `ChatPanel.tsx`：SSE 处理 `question.asked`——将 QuestionRequest 附加到最近的 assistant bubble；处理 `question.replied`——清除 question 字段；`handleQuestionReply` 乐观更新 + 调用 API；`handleQuestionReject` 跳过；newChat 时清理 questionBubbleRef
- [x] `ChatPanel.tsx MessageBubble`：渲染 `<QuestionBlock>` 和已回答的只读摘要；有 pending question 时不显示 ThinkingDots

## M12 — 刷新体验优化 & slides-it stop ✅

- [x] `frontend/src/App.tsx`：移除 `beforeunload` → `sendBeacon('/api/shutdown')`，刷新不再触发 server 关闭
- [x] `frontend/src/App.tsx`：新增 `loading` page 状态；mount 时调用 `GET /api/status`；若 server 已就绪且有 workspace，直接跳过 WorkspaceSelector 进入 chat 页（无需重新选择目录）；若 server 未就绪则正常显示 WorkspaceSelector
- [x] `slides_it/cli.py`：新增 `slides-it stop` 命令，kill port 4096（opencode）和 port 3000（slides-it server）上的进程
- [x] `slides_it/cli.py`：补充缺失的 `from slides_it.templates import TemplateManager` 导入（修复 `template list` 等命令的 NameError）

---

## M19 — SKILL/DESIGN 职责分离 & 演讲结构规范 ✅

**目标：** 明确 SKILL.md 和 DESIGN.md 的职责边界，消除规则冲突，新增演讲结构规范。

### 问题诊断
- SKILL.md 的 Visual Quality Rules 里有动画和图形元素的硬性规则，和 minimal DESIGN 的"opacity-only 动画"直接冲突
- SKILL.md 缺乏演讲结构规范（只说了 Title + Closing），导致 AI 生成的演讲缺少目录页、背景页、总结页、Q&A 页
- Icons 节在 html-template.md / default DESIGN / minimal DESIGN 三处重复
- Design Generation Mode 占 SKILL.md 近一半篇幅，每次生成演讲都白白消耗 token
- default 和 minimal 缺少 Slide Layout Variants 节，AI 不知道该 design 下各布局长什么样

### 职责边界（改后）
- **SKILL.md** = 不变的协议（对话流程 + HTML 工程约束 + 演讲结构 + 内容质量 + Layout Diversity 表格）
- **DESIGN.md** = 可变的风格（颜色/字体/动画/图形元素/布局变体 — 每个 design 自主决定，可 override SKILL 默认值）

### 任务清单
- [x] 删除 `slides_it/designs/plugandplay/` 目录
- [x] `slides_it/skill/SKILL.md`：
  - [x] 新增 `Required Slide Structure` 节（Cover → TOC → Background → Content → Summary → Closing）
  - [x] 精简 `Visual Quality Rules`：删除 Animation Quality + Graphic Elements 小节，替换为"由 design 定义"
  - [x] 精简 `Inline Editing`：删除 JS 代码示例，保留规则描述
  - [x] 精简 `Design Generation Mode`：Phase T2 模板用一句引用替代，Phase T3/T5 缩短
- [x] `slides_it/designs/default/DESIGN.md`：
  - [x] 删除旧 Icons 节（~35 行代码示例）
  - [x] 新增 `Icons & Graphic Elements` 节（Lucide CDN + 该 design 的图形元素要求）
  - [x] 新增 `Slide Layout Variants` 节（Stats Row / Two-Column / Step Flow / Feature Cards / Quote / Full-bleed Callout，Aurora glassmorphism 风格）
  - [x] Animations 节补充 cover 动画和 counter 动画规范
- [x] `slides_it/designs/minimal/DESIGN.md`：
  - [x] 删除旧 Icons 节（~35 行代码示例）
  - [x] 新增 `Icons & Graphic Elements` 节（icons 可选，靠排版和留白，无重装饰）
  - [x] 新增 `Slide Layout Variants` 节（同样 6 种布局，minimal 纸感风格：无 glow、无 glassmorphism）
  - [x] Animations 节加 override 声明（明确 opacity-only 覆盖 SKILL 默认值）
- [x] `slides_it/skill/SKILL.md`：
  - [x] Phase T3 从"3 slides"改为"7 slides"，列出每页对应的 Layout Variant
  - [x] Active Design Reference 的 preview_html 描述同步更新为 7-slide
- [x] `slides_it/designs/default/preview.html`：
  - [x] 重写为 7 页，每页展示一种 Layout Variant（Cover / Feature Cards / Stats Row + counter 动画 / Two-Column / Step Flow / Quote Block / Closing）
  - [x] 新增 `animateCounters()` JS（Stats Row counter 动画）
  - [x] 新增 `.title-reveal` CSS（Cover 专用 translateY + scale 动画）
- [x] `slides_it/designs/minimal/preview.html`：
  - [x] 重写为 7 页，每页展示一种 Layout Variant（Cover / Feature Cards / Stats Row 静态 / Two-Column / Step Flow / Quote Block / Closing）
  - [x] Stats Row 使用静态数字 + fade-in（无 counter 动画，符合 minimal 定义）
  - [x] 全部使用 opacity-only 动画（无 translateY）

### 16:9 宽高比约束 + 内容宽度分层
- [x] `slides_it/skill/SKILL.md` CSS Rules：
  - [x] 新增 16:9 aspect ratio 规则（`.slide` flex 居中 + `.slide-inner` `max-width: min(960px, calc(100dvh * 16/9))` + `aspect-ratio: 16/9`）
  - [x] 新增 `.slide-inner.wide`（1120px）用于多列布局
  - [x] 说明 Cover/Quote/Closing 用默认宽度，Feature Cards/Stats/Two-Column/Step Flow 用 `.wide`
- [x] `slides_it/designs/default/DESIGN.md` Slide Layout：更新为 16:9 + 双宽度描述
- [x] `slides_it/designs/minimal/DESIGN.md` Slide Layout：更新为 16:9 + 双宽度描述（880px / 1060px）
- [x] `slides_it/designs/default/preview.html`：CSS 加 16:9 约束 + `.wide`，Slide 2/3/4/5 加 `wide` class
- [x] `slides_it/designs/minimal/preview.html`：CSS 加 16:9 约束 + `.wide`，Slide 2/3/4/5 加 `wide` class
- [x] `html-template.md`：Base HTML Structure 同步更新（`.slide-inner` + `.wide` + 16:9 CSS）

---

## M20 — Industry（行业）系统 🚧

**目标：** 新增行业维度，让 AI 生成的 slides 内容结构能根据不同行业动态调整。行业（内容结构）与 Design（视觉风格）正交，可自由组合。

### 决策记录
- **架构模型：** 三层 prompt — `SKILL.md`（核心协议）→ `INDUSTRY.md`（行业定义）→ `DESIGN.md`（视觉风格）
- **注入方式：** System prompt 注入为主（每条消息自动携带，100% 可靠）；Design 保留 preview.html 的 agent curl 查询
- **行业 vs Design：** 独立选择，自由组合（如 [硬科技投资] × [minimal]）
- **触发方式：** 前端 UI pill 选择器（和 Design pill 平行）
- **分发方式：** 内置 + 可扩展（CLI/API 安装更多行业）
- **第一版行业：** `general`（通用，默认）+ `deeptech-investment`（硬科技投资）

### INDUSTRY.md 格式
```markdown
---
name: deeptech-investment
description: 硬科技投资——半导体、量子计算、核能、新能源、创新药等
author: slides-it
version: 1.0.0
---

（行业定义 body：角色、报告结构、AI 逻辑引擎指令、视觉偏好建议）
```

### 文件结构
```
slides_it/industries/          ← 内置种子
  general/INDUSTRY.md
  deeptech-investment/INDUSTRY.md
slides_it/industries.py        ← IndustryManager

~/.config/slides-it/industries/ ← 运行时存储
  general/INDUSTRY.md
  deeptech-investment/INDUSTRY.md
~/.config/slides-it/config.json ← 新增 "activeIndustry"
```

### System Prompt 拼接顺序
```
<!-- Active design: {name} -->
<!-- Active industry: {name} -->
{core SKILL.md}
---
{INDUSTRY.md body}
---
{DESIGN.md body}
```

### 任务清单

**Phase 1 — 后端**
- [x] `slides_it/industries.py`：`IndustryManager` 类（list / install / remove / activate / active / get_skill_md），对标 `designs.py` 的 `DesignManager`
- [x] `slides_it/industries/general/INDUSTRY.md`：通用行业定义（空 body，不覆盖 SKILL.md 默认结构）
- [x] `slides_it/industries/deeptech-investment/INDUSTRY.md`：硬科技投资行业完整定义
- [x] `slides_it/designs.py`：`build_prompt()` 加 `industry_name` 参数，实现三层拼接
- [x] `slides_it/server.py`：新增 industry CRUD API（GET /api/industries、GET /api/industry/{name}、PUT /api/industries/{name}/activate、POST /api/industries/install、DELETE /api/industries/{name}、GET /api/industry/{name}/skill）

**Phase 2 — 前端**
- [x] `frontend/src/lib/slides-server-api.ts`：新增 `listIndustries()`、`activateIndustry()`、`getIndustrySkill()` 等函数
- [x] `frontend/src/App.tsx`：新增 `activeIndustry` state；workspace ready 时加载 active industry；`handleIndustryChange` 异步切换
- [x] `frontend/src/components/ChatPanel.tsx`：新增 Industry pill（和 Design pill 平行），切换后发消息通知 AI

**Phase 3 — Prompt**
- [x] `slides_it/skill/SKILL.md`：新增 Industry Context 节，说明行业定义可覆盖默认 slide 结构

---

## 视觉修复 — 2026-04-01

### 问题
1. 内容过于居中，边框留白过多 — minimal 和 default 设计的 max-width 太小，padding 过大
2. minimal 设计 card 需要毛玻璃效果 — 当前为纯白实色，无 backdrop-filter

### 改动范围（已完成）
- [x] `slides_it/designs/minimal/DESIGN.md`：max-width 880px→1060px / 1060px→1200px，padding 减半，cards 改为毛玻璃（backdrop-filter: blur(16px), rgba(255,255,255,0.55)），更新 --bg-card / --border 变量，移除所有"no glassmorphism"描述
- [x] `slides_it/designs/minimal/preview.html`：同步以上布局和 card 改动；geo-shape 颜色恢复暖橙色（#FFB347等），opacity 降至 0.20/0.15
- [x] `slides_it/designs/default/DESIGN.md`：max-width 960px→1060px / 1120px→1200px，padding 减半
- [x] `slides_it/designs/default/preview.html`：同步布局和 padding 改动
- [x] `slides_it/skill/SKILL.md`：核心 CSS 模板 max-width 和 padding 参考值同步更新

---

## ESC 中断修复 + DESIGN.md 一致性 — 2026-04-01

### 问题
1. ESC 双击中断 agent 无效 — `onKeyDown` 仅在 textarea 有 focus 时生效，用户生成期间点击其他区域后 ESC 失效
2. minimal/default 两套 DESIGN.md 与 preview.html 存在多处不一致

### 改动范围（已完成）
- [x] `frontend/src/components/ChatPanel.tsx`：ESC abort 重构
  - 新增 `escWarning` state + `escTimerRef`，替换旧的 400ms double-tap `lastEscRef`
  - 新增 `handleEscPress()` 共享函数：第一次 ESC 显示橙色警告，3 秒内第二次 ESC 调用 `handleAbort()`
  - 新增 document-level `keydown` useEffect（仅 sending=true 时注册），作为 textarea 失去 focus 时的 fallback
  - textarea `onKeyDown` ESC 分支改用 `handleEscPress()`
  - hint 文字：正常显示 `Tab · @ · Enter · Esc`，警告状态显示橙色 `Press ESC again to stop`
  - `handleAbort()` 加入 `setEscWarning(false)` + `escTimerRef` 清理
- [x] `slides_it/designs/minimal/DESIGN.md`：与 preview.html 对齐（geo-shape blur 80→60px，h1 font-size/line-height，card padding，stat-number font-weight，Feature Cards grid 描述，reduced-motion 规则）
- [x] `slides_it/designs/default/DESIGN.md`：与 preview.html 对齐（aurora blur 100→80px，base opacity 0.4→0.6，aurora-3 opacity 0.25→0.4，stars opacity 0.4→0.7，stagger delay 说明修正）

---

## Bug 修复 — 2026-04-01

- [x] **server.py**：`@app.post("/api/start")` 装饰器错误地放在 `_IGNORE_CONTENT` 字符串常量上方，导致 `SyntaxError: invalid syntax`，`uv run slides-it` 启动失败。修复：将装饰器移回 `def start_workspace(...)` 的正上方。

---

## M22 — Sub-agent 可见性（Explore/General Task 显示）✅

**目标：** 当 AI 使用 Task tool 生成 explore/general sub-agent 时，在聊天中以树状结构展示 sub-agent 类型、描述和正在执行的子工具。

### 问题诊断
- M10 只处理了 `text` 和 `tool` 两种 part type，`task` tool 显示为普通工具调用
- 子 session 的 SSE 事件没有 sessionID 过滤，可能创建幽灵气泡
- sub-agent 正在做什么（读文件、搜索等）完全不可见

### 改动范围
- [x] `frontend/src/lib/typewriter.ts`：`ToolEntry` 新增 `childTools?: ToolEntry[]` 字段
- [x] `frontend/src/components/ToolBlock.tsx`：
  - 新增 `SubtaskBlock` 组件，`tool.tool === 'task'` 时渲染为树状结构
  - Header：`∴ Explore Task — description`（从 `tool.input.subagent_type` + `tool.input.description` 提取）
  - 子行：`└ Read file.ts` / `└ Grep pattern`（从 `tool.childTools[]` 渲染）
  - 点击展开可查看完整 prompt 和结果
- [x] `frontend/src/components/ThinkingDots.tsx`：`toolLabel` map 新增 `task: 'Running task'`
- [x] `frontend/src/components/ChatPanel.tsx`：
  - `message.updated`：新增 `sessionID` 过滤，忽略子 session 的 assistant 消息
  - `message.part.updated`：子 session 的 tool 事件路由到父 task tool 的 `childTools`
  - `message.part.delta`：新增 `sessionID` 过滤，忽略子 session 的 text delta
  - 新增 `session.created` 处理：将子 session 关联到对应的 pending task tool
  - 新增 `childSessionMapRef`、`pendingTaskToolsRef` 两个 ref

---

## M23 — 文档提取功能（PDF / Excel / Word / PPT / CSV）

**目标：** 让投资行业用户可以在 workspace 放入 PDF 研报、Excel 财务模型、Word 备忘录、PPT 参考模板等文件，AI 通过 slides-it server API 提取内容并用于生成 slides。

### 问题分析
- slides-it 在用户 workspace 写入 `.ignore` 文件，ripgrep 遵守此文件，导致 OpenCode 的 `read`/`grep`/`glob` 工具完全看不到 PDF/Excel/Word/PPT 等文件
- SKILL.md 的 File Access Rules 明确禁止 AI 读取这些格式
- 投资行业用户的核心材料就是这些格式，功能缺失严重

### 决策记录
- **方案：** 在 slides-it Python server 中新增 3 个 API 端点，AI 通过 `curl` 调用（与现有 design/industry API 模式一致）
- **不用 Custom Tool：** Custom Tool 依赖用户机器有 Python + pip 库，slides-it 是 PyInstaller 打包的二进制，不能假设用户有 Python 环境
- **不用 MCP Server：** 增加额外进程管理复杂度，且无法做智能截断
- **不用 markitdown：** 依赖膨胀严重（15+ 个递归依赖），PyInstaller 兼容风险高，功能过剩。直接用 4 个底层库更轻量可控
- **不做独立 Skill：** 文件提取是核心工作流的一部分，不是可选行为，应嵌入 SKILL.md 对话流程中
- **`.ignore` 保持不变：** 继续屏蔽文档格式，作为安全防线防止 AI 用 `read` 直接读二进制文件。文件发现只通过 `/api/documents` API（Python pathlib 不受 .ignore 影响）

### 四道防线
| 防线 | 机制 | 防什么 |
|------|------|--------|
| `.ignore` 继续屏蔽 | ripgrep 看不到文件 | AI 用 read/glob 直接访问二进制 |
| Server 端硬截断 | max_chars 50K 上限 | AI 一次提取过大内容打爆 context |
| Phase 1.8 流程嵌入 | 对话流程中的必经步骤 | AI 忘记用 extract API |
| File Access Rules | 末尾兜底规则 | 其他边缘情况 |

### API 端点
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/documents` | 列出 workspace 中所有文档和图片文件 |
| `POST` | `/api/documents/extract` | 提取文件内容为 markdown（支持分页、截断） |
| `GET` | `/api/documents/info?path=x` | 获取文件元信息（页数、sheet 名等） |

### 支持的格式
| 格式 | 库 | 投资行业场景 |
|------|-----|-------------|
| PDF (.pdf) | pdfplumber | 研报、BP、招股书 |
| Excel (.xlsx/.xls) | openpyxl | 财务模型、数据表 |
| Word (.docx/.doc) | python-docx | 投资备忘录、尽调报告 |
| PPT (.pptx/.ppt) | python-pptx | 参考 PPT、旧模板 |
| CSV (.csv) | csv (stdlib) | 数据导出 |

### 任务清单
- [x] `pyproject.toml`：新增依赖 pdfplumber, openpyxl, python-docx, python-pptx
- [x] `slides_it/server.py`：
  - [x] 新增 Pydantic models（DocumentEntry, ExtractRequest, ExtractResponse, DocumentInfoResponse）
  - [x] 新增提取函数（_extract_pdf, _extract_xlsx, _extract_docx, _extract_pptx, _extract_csv）
  - [x] 新增 3 个 API 端点（GET /api/documents, POST /api/documents/extract, GET /api/documents/info）
  - [x] 智能截断：PDF/PPT 按页截断，Excel 按 sheet/行截断，所有格式 50K 字符硬上限
- [x] `slides_it/skill/SKILL.md`：
  - [x] Phase 1 第 5 条从 "Images" 扩展为 "Reference materials"
  - [x] 新增 Phase 1.8 — Process Reference Materials（发现→确认→提取→使用）
  - [x] File Access Rules 重写：文档格式指向 API，图片可嵌入，二进制不可访问
- [x] `build.sh`：新增 hidden-import（pdfplumber, pdfminer, openpyxl, docx, pptx）

---

## M24 — 统一文件引用：前端只发路径，AI 决定如何读取

**目标：** 前端不再区分文件类型做不同处理（base64 / 路径），所有 `@` 引用和粘贴的文件统一发送路径给 AI。AI 根据 SKILL.md 指引决定如何读取每种文件类型。

### 问题分析
- 之前前端将图片/PDF 做 base64 编码作为 FilePart 直接塞进 prompt，大文件打爆 context 且绕过了 50K 截断保护
- Excel/Word/PPT 作为路径发送，但 AI 尝试 `read` 时遇到 `.ignore` 阻塞，用户体验差
- 前端包含了不应有的文件类型判断逻辑（`BINARY_EXTS`、`isAttachableAsFile`、`fileToFilePart`）

### 决策记录
- **前端职责：** 只负责文件选择和展示 `[filename]` 徽章，发送时只附加路径
- **AI 职责：** 根据 SKILL.md 的 File Access Rules 决定如何处理每种文件
  - 图片 → 用 `read` 工具（OpenCode 原生支持，返回 base64 视觉附件，AI 能看到图片）
  - 文档 → 用 `/api/documents/extract` API（50K 截断保护）
  - 文本/代码 → 用 `read` 工具直接读取
- **PDF 不再走 base64 FilePart：** 统一走 extraction API，获得截断保护和分页控制
- **SKILL.md 更新：** 修正 `.ignore` 对 `read` 工具无效的错误描述；允许 AI `read` 图片文件

### 任务清单
- [x] `frontend/src/lib/opencode-api.ts`：
  - [x] 删除 `FilePart` 接口、`BINARY_EXTS`、`isAttachableAsFile()`、`fileToFilePart()`
  - [x] 删除 `import { getFileBase64 }`
  - [x] 删除 `MIME_MAP`、`guessMime()`（无其他引用，已成死代码）
  - [x] `sendPrompt()` 移除 `fileParts` 参数
- [x] `frontend/src/components/ChatPanel.tsx`：
  - [x] 删除 `fileToFilePart`、`isAttachableAsFile`、`FilePart` 导入
  - [x] `handleSend()` 中删除 binary/text 分流逻辑，所有引用统一走路径
  - [x] `lastPromptRef` 类型移除 `fileParts`
  - [x] replay resend 移除 `fileParts` 参数
  - [x] `handlePaste` 注释更新（不再提 FileParts）
- [x] `slides_it/skill/SKILL.md`：
  - [x] File Access Rules 重写：修正 `.ignore` 对 `read` 无效的描述
  - [x] 图片规则：从 "不要 read" 改为 "用 read 查看"
  - [x] 文档规则：保持 extraction API 路线
- [x] `npm run build` 编译通过，零错误

---

## 16:9 Transform Scale 重构 + AI 自主调研

### 决策记录

#### 16:9 等比缩放方案
- **问题：** 当前方案 `.slide { height: 100dvh }` + `.slide-inner { aspect-ratio: 16/9; max-width: min(1060px, calc(100dvh*16/9)) }` 在手机竖屏上 slide-inner 被挤成极小的条带，字体用 `vw` 做 clamp 导致不同设备排版比例不一致
- **方案：** 固定 1920×1080px 设计画布 + `transform: scale()` 等比缩放适配任意视口
  - `.slide` 保持 `100dvh` + `scroll-snap-align: start` + flex 居中
  - `.slide-canvas` 固定 `1920×1080`，JS 计算 `scale = Math.min(vw/1920, vh/1080)`
  - 所有字体/间距改为固定 `px`，去掉所有 `clamp()`
  - Letterbox 区域由 body 背景色（`--bg-primary`）+ position:fixed 背景层自然填充
  - 手机竖屏 scale≈0.2，内容很小但用户可自行横屏
- **影响范围：** SKILL.md、两个 DESIGN.md、两个 preview.html（5 个文件）
- **不影响：** 已生成的 slides（独立 HTML 文件）、前端代码、server.py

#### AI 自主调研策略（Research-First Protocol）
- **问题：** AI 过于被动，什么都先问用户，不主动从 workspace 文件中提取信息
- **方案：** 三层调研策略
  1. Workspace 文档（第一优先级）— 始终自动扫描 + 全量提取，不逐一询问
  2. AI 自身知识（第二优先级）— 用训练数据补充公开背景，标注 `[Source: AI 公开知识，建议核实]`
  3. 用户补充（第三优先级）— 只对前两层无法覆盖的关键信息提问
- **影响范围：** SKILL.md Phase 1.8 改为全局主动调研 + deeptech-investment INDUSTRY.md 新增 §2.5 详细调研流程

#### Lucide Icons 强制规则
- 在 SKILL.md 核心 HTML Generation Rules 中加入强制使用 Lucide Icons 的规则
- 所有 design 必须使用 Lucide CDN，不允许其他图标库

#### ~~未来：联网搜索能力~~  → 已实施：open-webSearch MCP 集成
- **选型调研：** 评估了 Brave Search MCP、DuckDuckGo MCP、Ferris-Search、web-search-mcp、open-webSearch
- **排除 DuckDuckGo MCP：** curl 测试 DuckDuckGo 返回 HTTP 202 challenge，在当前网络环境下被反爬拦截
- **排除 Ferris-Search：** 需要 Rust toolchain 编译，对终端用户（投资行业人士）不友好
- **排除 Brave Search MCP：** 需要 API key（虽然有免费额度），增加用户配置成本
- **最终选择 open-webSearch：** 零 API key、多引擎 fallback（Bing/Baidu/Brave/DDG/Startpage）、内置中文搜索引擎支持、`npx open-websearch@latest` 一行启动
- **实现方式：** 在 `server.py` 的 `_write_opencode_jsonc()` 中无条件写入 `mcp.web-search` 配置块，OpenCode 自动启动 MCP server
- **零用户配置：** 不新增任何 Settings UI 字段，默认启用
- **Prompt 层：** SKILL.md Phase 1.8 新增 Layer 2.5 联网搜索指导，INDUSTRY.md (deeptech) 新增 Step 4.5 联网搜索策略
- **优雅降级：** 如果搜索工具不可用或全部失败，AI 静默跳过，不影响正常使用

### 任务清单 — 联网搜索集成
- [x] `slides_it/server.py`：`_write_opencode_jsonc()` 无条件写入 `mcp.web-search` 配置块
- [x] `slides_it/server.py`：新增 `_ensure_mcp_config()` 在 workspace 启动时确保 MCP 配置存在
- [x] `slides_it/server.py`：`_MCP_WEB_SEARCH_BLOCK` 常量提取到 Constants 段
- [x] `slides_it/skill/SKILL.md`：Phase 1.8 新增 Layer 2.5 联网搜索
- [x] `slides_it/industries/deeptech-investment/INDUSTRY.md`：§2.5 新增 Step 4.5 联网搜索策略
- [x] `todo.md`：记录决策（本节）
- [x] 同步 `~/.config/slides-it/industries/deeptech-investment/INDUSTRY.md`

### 任务清单
- [x] `todo.md`：记录决策（本节）
- [x] `slides_it/skill/SKILL.md`：
  - [x] CSS Rules → 1920×1080 固定画布 + `.slide-canvas` + `transform: scale()`
  - [x] JS Rules → `setupScaling()` 方法加入 `SlidePresentation` class
  - [x] Typography 指导改为固定 px
  - [x] Phase 1.8 → 主动调研三层策略
  - [x] 加入 Lucide Icons 强制规则
- [x] `slides_it/industries/deeptech-investment/INDUSTRY.md`：
  - [x] 新增 §2.5 自主调研流程（信息映射表 + 三层策略 + 禁止规则）
- [x] `slides_it/designs/default/DESIGN.md`：
  - [x] Typography/spacing `clamp()` → 固定 px
  - [x] Slide Layout 更新为 `.slide-canvas` 方案
- [x] `slides_it/designs/minimal/DESIGN.md`：同上
- [x] `slides_it/designs/default/preview.html`：完整实现新方案
- [x] `slides_it/designs/minimal/preview.html`：完整实现新方案
- [x] 同步更新 `~/.config/slides-it/` 下的 designs + industries 文件
- [x] `npm run build` 验证前端无错误（零错误，零 TypeScript 错误）

### 任务清单 — 三层职责重构
- [x] `INDUSTRY.md` §2.5 重写：去掉与 SKILL.md 重复的调研流程（curl 命令、Step 1-2 扫描提取、Step 4 AI 补充、Step 5 差距分析、禁止规则），只保留行业特有内容（信息映射表、搜索关键词策略、行业特定规则）
- [x] `SKILL.md` Rules 段新增禁止用 `read` 读 PDF/Excel/Word/PPT/CSV 的规则（防止撑爆上下文）
- [x] `AGENTS.md` 新增 "Three-Layer Responsibility Boundaries (CRITICAL)" 段，明确三层的 Forbidden 清单，防止未来重复
- [x] 同步 `~/.config/slides-it/industries/deeptech-investment/INDUSTRY.md`

### README.md 重写
- [x] 安装流程简化：移除手动安装 opencode 步骤（install.sh 自动安装）
- [x] 新增 "Open a terminal" 段落（推荐 Ghostty，附 macOS/Linux/Windows 打开方式）
- [x] 新增完整首次使用流程（workspace → provider → chat）
- [x] 新增 API key 注册链接（Anthropic/OpenAI/OpenRouter/DeepSeek）
- [x] 所有 "template" → "design"（CLI 命令、描述文案全部更新）
- [x] 语气调整：减少 "You" 开头句式，去掉攻击性措辞
- [x] "What it looks like" + "Idea" 合并为 "How it works"
- [x] 新增 "For Contributors" section（三层架构、Build your own design、Build your own industry）
- [x] CLI reference 更新为 `design` 命令
- [x] Design 表格增加 preview 链接
- [x] Build your own design 增加 preview.html 推荐说明
- [x] 新增 "Endless conversation" feature section（replay/compaction 功能介绍）
- [x] 安装命令按 macOS / Linux / WSL2 分开列出
- [x] Features section 重写：从原理说明改为用户体感描述（Designs/Industries/Live preview/Endless conversation）

---

## Canvas 填充 + flex-shrink 修复 — 2026-04-03

### 问题
1. `.slide-canvas` 在 preview.html 中被 flex 容器压缩为 ~4:5 宽高比，原因是缺少 `flex-shrink: 0`（默认 `flex-shrink: 1` 将 1920px 压缩到视口宽度）
2. 两个 DESIGN.md 缺少"画布填充"指导，AI 生成的 slides 内容只占画布 30-50%，大量空白
3. 两个 preview.html 的内容稀疏，没有体现画布利用率

### flex-shrink 修复（已完成）
- [x] `slides_it/skill/SKILL.md`：`.slide-canvas` 加 `flex-shrink: 0`
- [x] `slides_it/designs/default/preview.html`：同上
- [x] `slides_it/designs/minimal/preview.html`：同上

### Canvas 填充指导 + Preview 重做
- [x] `slides_it/designs/default/DESIGN.md`：Slide Layout 段新增 "Canvas utilization" 规则（70-80% 画布利用率）
- [x] `slides_it/designs/minimal/DESIGN.md`：同上（适配 minimal 风格描述）
- [x] `slides_it/designs/default/preview.html`：全面重做 — CSS 拉伸 + 内容扩充 + 装饰元素填充（aurora 风格）
- [x] `slides_it/designs/minimal/preview.html`：全面重做 — CSS 拉伸 + 内容扩充 + 装饰元素填充（纸感风格）

---

## 正文字号放大 + ECharts Donut Chart — 2026-04-03

### 问题
1. 两个 preview.html 的正文文字在 1920×1080 画布上过小（card-body 14px、label 11px 等，缩放后几乎看不清）
2. 第 4 页（Two-Column）左右两栏纵向占比不对称，左栏内容过少
3. 缺少 ECharts 图表示范，AI 生成演讲时没有数据可视化参考

### 字号调整（DESIGN.md 权威规格 + preview.html 同步）
| 元素 | 旧值 | 新值 |
|------|------|------|
| label | 11px | 13px |
| card-label | 10px (default) / 11px (minimal) | 12px / 13px |
| card-title | 19px (default) / 22px (minimal) | 22px / 24px |
| card-body | 14px | 17px |
| body-text / two-col-main p | 16px | 18px |
| stat-label | 14px | 15px |
| stat-desc | 13px | 15px |
| step-title | 18px | 20px |
| step-desc | 14px | 16px |
| evidence-list li | 16px | 18px |
| two-col-main h2 | 32px | 36px |
| quote blockquote | 32px (default) / 36px (minimal) | 36px / 40px |
| quote cite | 12px (default) / 13px (minimal) | 14px |

### ECharts Donut Chart（第 4 页 Two-Column 左栏）
- [x] `slides_it/designs/default/DESIGN.md`：Typography 段字号更新 + 新增 "Data Visualization (ECharts)" 节
- [x] `slides_it/designs/minimal/DESIGN.md`：Typography 段字号更新 + 新增 "Data Visualization (ECharts)" 节
- [x] `slides_it/designs/default/preview.html`：
  - [x] CSS 字号全面放大（13 处修改）
  - [x] 新增 ECharts CDN `<script>` 标签
  - [x] Slide 4 左栏新增 320×320px donut chart（Layout 45% / Typography 30% / Color 25%，aurora 三色）
  - [x] ECharts 初始化代码（aurora 配色、Clash Display 中心标签、canvas renderer）
- [x] `slides_it/designs/minimal/preview.html`：
  - [x] CSS 字号全面放大（13 处修改）
  - [x] 新增 ECharts CDN `<script>` 标签
  - [x] Slide 4 左栏新增 320×320px donut chart（Typography 50% / Spacing 30% / Contrast 20%，单色暖调）
  - [x] ECharts 初始化代码（单色暖调配色、DM Serif Display 中心标签、animation: false）

### 层级职责
- **DESIGN.md（Layer 3）**：拥有字号规格和 ECharts 视觉风格指导（配色、字体、动画策略）
- **preview.html**：实现参考，与 DESIGN.md 规格保持一致
- **SKILL.md（Layer 1）**：未修改（字号和图表视觉均为 Layer 3 职责）

---

## setCacheKey 启用 Prompt Caching — 2026-04-03

### 背景
OpenCode 支持 `setCacheKey` provider 选项，设置后确保每次 API 请求都携带 cache key。
对 Anthropic 来说，这启用了 prompt caching——slides-it 的大 system prompt（SKILL.md + INDUSTRY.md + DESIGN.md 拼接）
和之前的对话上下文会被缓存，显著降低延迟和 token 成本。

### 改动
- [x] `slides_it/server.py` — `_write_opencode_jsonc()`：options dict 新增 `"setCacheKey": True`（新设置保存时生效）
- [x] `slides_it/server.py` — `_ensure_mcp_config()`：每次 workspace 启动时遍历已有 provider options，补上 `setCacheKey: true`（老 workspace 追溯生效）

### 生成的 opencode.json 示例
```json
{
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "sk-ant-...",
        "setCacheKey": true
      }
    }
  }
}
```

---

## Content Mapping Guide — 内容→视觉元素映射 — 2026-04-04

### 问题
DESIGN.md 是优秀的视觉规格书（CSS 怎么写、颜色怎么用），但缺失"什么内容用什么视觉元素"的映射。
AI 能精确复制每个元素的样子，但不知道什么时候该用哪个。原来 SKILL.md 里有 5 行 mapping 表，
但那属于视觉偏好（Layer 3 职责），不应该放在操作协议层（Layer 1）。

### 职责调整
- **SKILL.md（Layer 1）**：删除 5 行 content-to-layout 表，保留"Layout Diversity"规则，
  新增 delegation 指向 DESIGN.md 的 Content Mapping Guide
- **DESIGN.md（Layer 3）**：新增完整的 Content Mapping Guide，各 design 可以有不同的映射偏好

### 改动
- [x] `slides_it/skill/SKILL.md`：删除 5 行 mapping 表，替换为 delegation 语句
- [x] `slides_it/designs/default/DESIGN.md`：新增 ~65 行 Content Mapping Guide
  - content-to-layout 表（12 种内容模式 → 布局推荐 + aurora 风格注释）
  - element-level 选择指南（gradient-text、accent line vs divider、icon 选择、card label、decorative fills）
  - Common Mistakes（7 条）
- [x] `slides_it/designs/minimal/DESIGN.md`：新增 ~70 行 Content Mapping Guide
  - content-to-layout 表（11 种内容模式，无 Full-bleed Callout，适配 minimal 风格）
  - element-level 选择指南（italic emphasis、dividers/rules、icon 选择、card label、decorative fills）
  - Common Mistakes（6 条，适配 minimal 规则）

## ECharts 图表类型泛化（v1.7.5）

### 问题
之前 DESIGN.md 的 Data Visualization 部分只记录了 donut chart 的样式，Content Mapping Guide
也把"量化数据"硬编码为"Two-Column + ECharts donut"。这会导致 AI 对所有数据都默认用 donut，
但实际上不同数据应该用不同图表：趋势→折线、对比→柱状、占比→饼/环、排名→横向柱状。
布局也不应该硬绑 Two-Column —— 全幅、组合、卡片内嵌 sparkline 都是合理选项。

### 改动
- [x] `slides_it/designs/default/DESIGN.md`：Data Visualization 重构
  - 新增 Chart Type Selection 表（6 种数据模式 → 图表类型 + 推荐布局）
  - 新增 Shared Aurora chart styles（通用色板、轴线、动画、tooltip）
  - 保留 Pie/Donut 小节，新增 Bar + Line/Area 小节（各含 aurora 风格参数）
  - Content Mapping Guide 表：「Quantitative breakdown → Two-Column + donut」改为
    「Quantitative data / chart → ECharts — layout varies」
  - Common Mistakes 新增：「Always using donut charts for data → match chart type to data pattern」
- [x] `slides_it/designs/minimal/DESIGN.md`：同构重构
  - 同样的 Chart Type Selection 表 + Shared monochrome chart styles
  - Bar 小节：无圆角、无渐变（适配 minimal 纪律）
  - Line/Area 小节：1.5-2px 线宽、无 glow、6-10% 纯色填充
  - Content Mapping Guide 表：同样去掉硬编码 donut + Two-Column
  - Common Mistakes 新增：同上
- preview.html 不改（donut 作为一个合法示例保留，DESIGN.md 已明确它只是多种图表之一）

## Component Library 架构重构（v1.7.5）

### 问题
1. **preview.html 冗余注入 AI context**：DESIGN.md 已通过 system prompt 注入，但 SKILL.md 还指示
   AI curl 获取 `/api/design/<name>` 把 ~900 行 preview.html 也拉进来。重复且有冲突风险。
2. **DESIGN.md 不够自足**：Layout Variants 只有文字描述（"Stats Row — 3-column grid..."），
   没有具体 HTML 结构和 CSS 代码。AI 只能靠 preview.html 或自己猜 class 命名。
3. **刚性布局模板**：6 种固定 layout（Stats Row、Feature Cards 等）限制了 AI 灵活组合组件。
   数据图表被绑定到 Two-Column，各种元素被绑定到特定页面类型。
4. **default/DESIGN.md 缺少 line-height、letter-spacing**。

### 架构调整
- **"6 种布局模板"→"组件库 + 布局原语 + 组合指南"**
  - Component Library：独立可组合的构建块（Card、Stat Card、Quote Block、Step Flow、
    Evidence List、Chart Container、Text Helpers、Accent Lines、Decorative Fills、Reveal Animation）
  - Layout Primitives：布局工具（Centered Stack、Top-Aligned Stack、Two-Column Grid、
    Three-Column Grid、Horizontal Flow）
  - Composition Guide：内容→组件+布局的推荐组合（明确说明是起点而非约束）
- **移除 preview.html 从 AI context**：DESIGN.md 是 AI 唯一的视觉参考
- **preview.html 保留给人类**：设计选择器的 iframe 预览不受影响

### 改动
- [x] `slides_it/designs/default/DESIGN.md`：
  - Typography 扩展（+line-height, letter-spacing, 缺失的 font-weight）
  - 删除：Cards & Glassmorphism、Accent Elements、Animations、Icons & Graphic Elements、
    Slide Layout Variants、Content Mapping Guide（~180 行）
  - 新增：Component Library（~210 行）、Layout Primitives（~50 行）、Composition Guide（~50 行）
  - Data Visualization：Chart Type Selection 表 "Typical Layout"→"Common Placements"
- [x] `slides_it/designs/minimal/DESIGN.md`：同构重构，minimal 特有的 CSS 值
  - Reveal: opacity-only, 0.4s（无 translateY）
  - Card: 12px radius, 无 glow, stat-card 有 border-bottom
  - Step: 实心圆、1px connector、无阴影
  - Evidence: em-dash bullet（非 cyan dot）
  - Dividers: .divider/.divider-wide/.heading-rule（非 accent-line）
  - Deco: .deco-circle/.deco-rule（非 .deco-blob/.deco-line）
- [x] `slides_it/skill/SKILL.md`：
  - 删除 "Active Design Reference" 中的 curl 指令（~15 行）
  - 更新 Visual Quality Rules：引用新的 section 名称
  - 更新 Phase T2：section 列表更新
  - 更新 Phase T3：7 slides → "at least 7 slides"，内容类型描述替代固定 layout 名称
  - Content width tier：去掉 layout variant 名称
- [x] Version bump: 1.7.4 → 1.7.5

---

## M25 — 图片压缩集成到文档提取 API ✅

**目标：** AI 读取图片前先通过 `/api/documents/extract` 压缩，避免大图消耗海量 token。

### 问题
- AI 通过 `read` 工具直接读取原始图片，OpenCode 返回完整 base64 视觉附件
- 一张 4MB PNG → base64 约 5.3MB → 消耗 ~40K token
- 用户上传的截图、设计稿、参考图通常都很大，token 消耗不可接受

### 决策
- **方案：** 图片集成到现有 `/api/documents/extract` 体系，和 PDF/Excel/Word/PPT/CSV 统一处理
- **压缩策略：** 所有图片都压缩（无阈值跳过），长边缩到 ≤1200px，转 JPEG quality=70
- **输出方式：** 返回 `optimized_path`，AI 再 `read` 压缩后的小文件（两步走，但 AI 能真正"看到"图片）
- **原图不动：** HTML 中 `<img src>` 仍引用原始路径，保证高清渲染
- **不新增 API 端点：** 复用现有 extract/info 端点，只在路由中新增图片分支

### Token 消耗对比
| 场景 | Before | After |
|------|--------|-------|
| 4MB PNG 截图 | ~5.3MB base64 → ~40K token | 180KB JPEG → ~1.4K token |
| 32MB 4K 截图 | 不可用（超出 context） | 152KB JPEG → ~1.2K token |
| 1MB JPEG 照片 | ~1.3MB base64 → ~10K token | 120KB JPEG → ~1K token |

### 任务清单
- [x] `pyproject.toml`：新增 `Pillow>=10.0` 依赖
- [x] `slides_it/server.py`：
  - [x] `ExtractResponse` 新增 `optimized_path` 和 `original_size_human` 字段
  - [x] `DocumentInfoResponse` 新增 `image_width` 和 `image_height` 字段
  - [x] 新增 `_extract_image()` 函数（Pillow 压缩：resize + RGBA→RGB + JPEG）
  - [x] `extract_document()` 路由新增 `_IMAGE_EXTENSIONS` 分支
  - [x] `document_info()` 新增图片分支（返回宽×高）
- [x] `slides_it/skill/SKILL.md`：
  - [x] Image Rules 精简：删除 Pillow 手动压缩指令（server 端自动做）
  - [x] File Access Rules 重写：图片和文档统一走 extract API，禁止直接 `read` 原图
- [x] `build.sh`：PyInstaller 新增 `PIL` / `PIL._imaging` / `PIL.Image` hidden-import
- [x] Smoke test：32MB 4K 图 → 152KB 压缩，server.py import 正常

---

## Future — PreviewPanel 动态注入编辑工具

### 背景
当前 inline editing JS 是 AI 每次生成时内联到 HTML 中的。两个问题：
1. 传给别人时对方也能看到编辑 UI（hover 边框等），不专业
2. 字号调整等功能无法在不污染生成 HTML 的情况下实现

### 方案
将所有编辑相关代码从 SKILL.md / 生成的 HTML 中移除，改为 PreviewPanel 在 iframe onLoad 后动态注入：

- **SKILL.md**：删除 inline editing 参考实现（~60 行），AI 生成的 HTML 不再包含编辑代码
- **PreviewPanel.tsx**：iframe onLoad 后通过 `contentDocument.createElement('script')` 注入编辑 JS
- **注入的 JS 包含**：
  - Hover 400ms → contenteditable 文字编辑
  - 选中元素时上方显示字号调整工具条 `[A-] [16px] [A+]`（±2px）
  - `window.getEditedHTML()` 返回 HTML 前自动清理注入的编辑 UI DOM
- **效果**：
  - slides-it 内预览时有完整编辑功能
  - 下载/Bundle/传给别人的 HTML 是干净的演示文件
  - AI 每次生成减少 ~60 行 token 消耗

### 文件改动
| 文件 | 改动 |
|---|---|
| `slides_it/skill/SKILL.md` | 删除 inline editing 参考实现，改为一句说明 |
| `frontend/src/components/PreviewPanel.tsx` | 新增 onLoad handler + EDITING_JS 常量 |

### 优先级
低 — 当前 inline editing 可用，此项是体验优化。

---

## DESIGN.md 自包含重构 + 图片组件 — 2026-04-04

### 问题
1. **AI 生成的 HTML 没有分页导航（nav dots / progress bar）**：SKILL.md 只给了 JS 方法骨架
   （`// ... full implementations of all other methods`），没有完整实现。AI 猜着写导致质量参差。
2. **缺少图片组件**：DESIGN.md 的 Component Library 只有纯文字 card（icon + label + title + body），
   没有图片 card。AI 不知道怎么展示图片（圆角、裁剪、caption）。
3. **三层职责边界模糊**：HTML 结构、CSS 结构规则、JS class 骨架分散在 SKILL.md 中，
   但这些都是 design 可以改变的实现细节，不是平台层面的硬约束。

### 决策
- **SKILL.md 只保留操作手册**：对话流程、内联编辑、内容质量、文件命名、Image Rules、文件访问规则
- **DESIGN.md 完整自包含**：每个 design 拥有完整的 HTML 骨架 + Core CSS + 全部 JS（`SlidePresentation` class）+ 组件库 + 导航
- **Navigation 全归 design**：nav dots、progress bar、keyboard/touch/wheel nav 的 CSS 和 JS 全在 DESIGN.md
- **新增 3 个图片组件**：Image Card（`.image-card`）、Card with Image Header（`.card-img`）、Avatar（`.avatar`）

### 从 SKILL.md 删除的内容
- HTML Structure 节（`<!DOCTYPE>` 骨架、`<div class="progress-bar">`、`<nav class="nav-dots">`）
- CSS Rules 节（`scroll-snap`、`.slide { height: 100dvh }`、`.slide-canvas { 1920x1080 }`、content width tiers、`clamp()` 禁令、`prefers-reduced-motion` 示例、动画触发规则）
- JavaScript Rules 节（`SlidePresentation` class 骨架、`setupScaling()`）
- Accessibility 节中具体 HTML 标签指导

### SKILL.md 替换为
简短引导：
> Generate a single self-contained `.html` file with all CSS and JS inlined.
> Follow the active design for HTML structure, CSS, JavaScript, components, and navigation.

### 每个 DESIGN.md 新增
1. **HTML Structure**：完整 `<!DOCTYPE>` 骨架（含该 design 的 font link、背景 HTML）
2. **Core CSS**：`scroll-snap`、`.slide`、`.slide-canvas`、content width tiers、`prefers-reduced-motion`
3. **Navigation & Progress**：nav dots + progress bar 的 HTML 容器 + CSS + 完整 JS
4. **`SlidePresentation` 完整 class**：setupScaling + setupIntersectionObserver + nav 全部方法
5. **Image Card (`.image-card`)**：圆角图片 + 可选 caption
6. **Card with Image Header (`.card-img`)**：顶部图片 + 下方文字的复合 card
7. **Avatar (`.avatar`)**：圆形裁剪，sm/md/lg 三种尺寸

### 文件改动
- [x] `slides_it/skill/SKILL.md`：删 HTML Structure / CSS Rules / JS Rules，替换为简短引导；Image Rules 加指引
- [x] `slides_it/designs/default/DESIGN.md`：新增 HTML Structure + Core CSS + Navigation & Progress + SlidePresentation JS + 3 个图片组件
- [x] `slides_it/designs/minimal/DESIGN.md`：同上，minimal 风格
- [x] 同步 `~/.config/slides-it/designs/` 下的文件

---

## Showcase 组件 + ribbon DESIGN.md 补全 — 2026-04-04

### 问题
1. **AI 自创中间容器**：AI 在生成 slides 时会在 `.reveal` 和组件之间插入半透明容器
   （如 `.component-demo-box`），效果好（增加视觉层次），但名字不稳定、CSS 定义缺失，
   可能导致内容 top-align 而非居中。
2. **ribbon/DESIGN.md 不自包含**：Slide Layout 写 "Keep all existing layout rules unchanged"，
   HTML Structure 写 "keep the exact HTML skeleton from the original theme"——
   SKILL.md 已删除这些内容，AI 找不到参考。

### 决策
- **正式收编为 `.showcase` 组件**：半透明展示容器，每个 design 有匹配的视觉样式，
  CSS 保证 `display: flex; align-items: center; justify-content: center; flex: 1;`
- **ribbon DESIGN.md 补全**：用具体规则替换所有 "unchanged" / "original theme" 引用

### 文件改动
- [x] `slides_it/designs/default/DESIGN.md`：Component Library 新增 `.showcase`（glassmorphism + 16px radius）
- [x] `slides_it/designs/minimal/DESIGN.md`：Component Library 新增 `.showcase`（frosted glass + 12px radius）
- [x] `slides_it/designs/ribbon/DESIGN.md`：
  - Component Library 新增 `.showcase`（半透明纸感 + dark variant for title-slide）
  - Slide Layout：替换为具体的 1920x1080 canvas 规则、content width tiers、canvas utilization 指导
  - HTML Structure：替换为完整 `<!DOCTYPE>` 骨架（Google Fonts、Lucide CDN、geo-shape divs、data-index）

---

## UI 重构 + CLI 后台运行 — 2026-04-06

### 需求 1: 彻底取消 PreviewPanel
- [x] `App.tsx`：删除 PreviewPanel import/渲染、previewFile state、toRelative helper、onFileClick 中的 preview 逻辑；onHtmlGenerated 只保留 setFileTreeRefreshToken
- [x] `PreviewPanel.tsx`：删除整个文件
- [x] `FileTree.tsx`：删除右键菜单 "Preview" 选项；onFileClick prop 不再需要

### 需求 2: Switch Workspace 按钮（FileTree 标题栏左侧）
- [x] `server.py`：新增 `POST /api/switch-workspace`（停止 opencode，重置 workspace）
- [x] `slides-server-api.ts`：新增 `switchWorkspace()`
- [x] `FileTree.tsx`：header 左侧加 switch workspace 图标按钮
- [x] `App.tsx`：新增 `handleSwitchWorkspace`，传 prop 给 FileTree

### 需求 3: 默认后台运行（`slides-it` 默认后台，`--fg` 前台）
- [x] `cli.py`：新增 `--fg` 参数，默认 fork detached 子进程 + PID 文件 + 日志文件
- [x] `cli.py`：启动前检查 PID 文件 + 进程是否存活
- [x] `cli.py`：`stop()` 优先读 PID 文件发 SIGTERM

### 验证
- [x] `npm run build` 编译通过

---

## 补全 DESIGN.md 组件 display/justify-content 声明 — 2026-04-05

### 问题
三个 DESIGN.md 中多个组件缺少明确的 `display` 和 `justify-content` 声明，导致 AI 生成时内部对齐行为不确定。

### 改动
| 元素 | 补全内容 | 理由 |
|------|---------|------|
| `.card` | `justify-content: flex-start` | 卡片内容从顶部排列，`.card-body { flex: 1 }` 推剩余空间给 body |
| `.stat-card` | `display: flex; flex-direction: column; align-items: center; justify-content: center` | 数字+标签垂直居中 |
| `.two-col-aside` | `justify-content: center` | 与 `.two-col-main` 一致 |
| `.image-card` | `display: flex; flex-direction: column` | 图片+caption 垂直堆叠 |
| `.quote-block` | `display: flex; flex-direction: column; justify-content: center` | 引用内容居中 |

### 文件
- [x] `slides_it/designs/default/DESIGN.md`
- [x] `slides_it/designs/minimal/DESIGN.md`
- [x] `slides_it/designs/ribbon/DESIGN.md`

