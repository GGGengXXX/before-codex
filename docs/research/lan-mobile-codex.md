# 局域网手机网页控制本机 Codex 可行路线调研

调研时间：2026-08-24

## 1. 调研目标

本项目当前是面向 Codex 的本机 OpenAI Responses 中转站。新的问题是：是否可以在同一局域网内，用手机网页控制或交互本机 Codex 工作，例如发起任务、持续查看输出、处理审批、查看会话状态。

本次只基于一手资料：

- OpenAI / ChatGPT Learn 官方 Codex 文档；
- `openai/codex` 官方仓库和 README；
- Codex SDK、`codex app-server`、Codex MCP server、`codex exec`、CLI sandbox/approval 相关官方资料；
- 必要时基于官方源码作推断，并明确标注。

## 2. 结论摘要

最可行的 MVP 路线是：

> **手机浏览器 -> 本项目新增的局域网 Web UI/后端 -> Codex SDK 或 `codex exec` -> 本机工作区。**

其中更推荐 **Codex SDK** 作为 MVP 的核心执行层：它是官方面向程序化集成的接口，直接支持会话、事件流、工具调用、结构化错误和审批回调，适合把 Codex 事件转成浏览器 WebSocket/SSE。`codex exec` 可以作为更快落地的兼容后备，但它本质是一次性 CLI 执行，更适合“提交一个任务并看日志”，不适合作为完整的移动端交互协议。

不推荐把 `codex app-server` 直接暴露到局域网。官方文档明确把它定义为本地富客户端和 Codex CLI 之间的 WebSocket 服务，并警告它当前没有内建身份验证，必须只绑定 `127.0.0.1`。如需移动端使用，应该由本项目在本机提供一个带鉴权的局域网网关，再由网关连接本机回环地址上的 Codex 能力。

`codex mcp-server` 适合让另一个 Agent 调用 Codex，不适合直接给手机网页当后端。直接 PTY 包装 Codex TUI 最不推荐：它能保留 CLI 行为，但移动端交互、审批识别、事件结构化和安全边界都最脆弱。

## 3. 官方能力背景

### 3.1 Codex 开源组件

官方 Codex CLI 文档将 Codex CLI描述为开源本地 coding agent，支持交互式 TUI，也支持 `codex exec` 的非交互模式，并在同一文档中列出 `codex app-server` 和 `codex mcp-server` 等子命令。[来源：Codex CLI 文档](https://developers.openai.com/codex/cli)

OpenAI 的 `openai/codex` 仓库 README 也列出：

- `codex`：交互式 TUI；
- `codex exec "..."`：非交互运行；
- `codex mcp-server`：把 Codex 作为 MCP 工具暴露；
- `codex app-server`：实验性 app server；
- `codex login`、`codex logout`、`codex resume` 等本地会话命令。[来源：openai/codex README](https://github.com/openai/codex)

### 3.2 Codex SDK

官方 Codex SDK 文档说明，SDK 提供 TypeScript 和 Python 接口，用于把 Codex 嵌入应用。TypeScript 示例中，`Codex.startThread()` 创建线程，`thread.run()` 返回 async iterable，应用可以逐个消费事件。文档也展示了：

- 维护同一 thread 进行多轮；
- 监听 `agent_message_delta`、`exec_command_begin`、`patch_apply_*`、`task_complete` 等事件；
- 通过 `onItem` 接收完整事件项；
- 通过 `onError` 处理错误；
- 用 `onApprovalRequest` 响应命令审批和补丁审批；
- 配置 `workingDirectory`、sandbox、approval policy、model、profile、MCP servers 等选项。[来源：Codex SDK 文档](https://developers.openai.com/codex/sdk)

这说明 SDK 是官方最贴近“把 Codex 作为后端能力接入自定义 UI”的路线。

### 3.3 `codex app-server`

官方 app-server 文档说明，`codex app-server` 是一个本地 WebSocket bridge，用 JSON-RPC 连接富客户端和 Codex CLI，会在本地启动 `ws://127.0.0.1:<port>/codex`。文档列出的方法包括：

- `codex/startThread`；
- `codex/continueThread`；
- `codex/interrupt`;
- `codex/listThreads`;
- `codex/getThreadHistory`;
- `codex/sendMessage`;
- `codex/approval/submit`;
- `codex/input/response`;
- `codex/notify/sendNotification` 等。[来源：Codex app-server 文档](https://learn.chatgpt.com/codex/app-server)

这个协议天然支持多轮、事件流、历史、审批和打断，能力最接近“移动端 Codex UI”。但同一篇官方文档也明确警告：app-server 当前没有身份验证，必须只绑定 localhost，不要暴露到网络。[来源：Codex app-server 文档](https://learn.chatgpt.com/codex/app-server)

### 3.4 Codex MCP server

官方 MCP server 文档说明，`codex mcp-server` 让 Codex CLI 作为 MCP server 运行，并通过 Agents SDK 的 MCP client 调用。示例中，Agent 使用 `MCPServerStdio(params={"command": "codex", "args": ["mcp-server"]})` 连接，随后工具调用会返回 Codex 的执行结果。[来源：Codex MCP server 文档](https://learn.chatgpt.com/codex/mcp-server)

这条路线适合“让另一个 AI Agent 调用 Codex”，而不是直接给浏览器提供完整交互协议。浏览器若要使用 MCP server，仍需一个后端进程负责 stdio/MCP client、鉴权、会话、事件转发和审批 UI。

### 3.5 `codex exec`

官方 CLI 文档说明，`codex exec` 是非交互运行方式，适合自动化、脚本和 CI。官方仓库 README 也把它列为 “run non-interactively”。[来源：Codex CLI 文档](https://developers.openai.com/codex/cli)、[来源：openai/codex README](https://github.com/openai/codex)

由此可推断：`codex exec` 能较容易被本项目后端用子进程包装，并把 stdout/stderr 转给手机浏览器；但它不是官方声明的富交互协议，审批、打断、多轮状态和结构化事件需要额外约定或依赖命令行参数。

### 3.6 Sandbox 和审批

官方 sandbox 文档说明，Codex 在不同系统上使用不同 sandbox 技术限制网络和文件访问；还说明可通过配置调整 sandbox mode、网络访问和写入路径。文档同时给出风险提示：放宽 sandbox 或启用网络访问会增加风险，应在受信任工作区和最小权限原则下使用。[来源：Codex sandbox 文档](https://learn.chatgpt.com/codex/sandboxing)

对于局域网手机控制来说，这一点非常关键：一旦手机网页可以触发 Codex，就相当于把“在本机执行命令和修改文件”的能力间接暴露给局域网。因此移动端网关必须把鉴权、CSRF 防护、审批确认、日志审计和网络绑定作为 MVP 的一部分，而不是后续优化。

## 4. 集成方式对比

| 方式 | 多轮会话 | 流式事件 | 审批/权限 | 安全边界 | 移动端交互适配 | 结论 |
|---|---|---|---|---|---|---|
| Codex SDK | 支持。`startThread()` 后可复用 thread 多轮运行 | 支持。`thread.run()` 是 async iterable，并有 delta/item/error/complete 事件 | 支持。SDK 提供 approval request 回调，配置 sandbox/approval policy | 由本项目后端控制监听地址、登录态、token、TLS/局域网访问 | 很适合。后端把 SDK 事件转 WebSocket/SSE，手机端渲染即可 | **推荐 MVP 主路线** |
| `codex app-server` WebSocket | 支持。官方协议有 start/continue/list/history/sendMessage | 支持。协议是富客户端事件流 | 支持。官方方法包含 approval submit、input response、interrupt | 官方警告无内建身份验证，只能 localhost | 能力最完整，但必须包一层安全反向代理/网关 | **推荐后续路线，不直接暴露** |
| `codex mcp-server` | 间接支持。取决于 MCP client/Agent 如何管理会话 | 间接支持。MCP 工具调用可返回结果，但不是浏览器 UI 协议 | 间接支持。需要上层 Agent/后端处理 | stdio MCP server 本身不应暴露给浏览器 | 偏 Agent-to-Agent，不偏人机移动 UI | **适合未来 Agent 编排，不适合 MVP UI** |
| `codex exec` | 有限支持。可用 CLI resume/工作目录/命令参数维持状态，但不是天然长会话 UI | 有限支持。可转发 stdout/stderr，但结构化事件弱于 SDK/app-server | 有限支持。可通过 CLI 参数设置 approval/sandbox，但移动端审批体验较弱 | 后端可包子进程并加鉴权；命令注入和环境隔离要严格处理 | 适合“一次任务 + 日志流 + 结束状态” | **可做快速 fallback/原型** |
| 直接 PTY 包装 `codex` TUI | 可能支持，因为 TUI 本身支持交互会话 | 字符流，不是结构化事件 | 依赖 TUI 文本和快捷键，难可靠自动化 | 风险最高。终端能力、ANSI、输入注入、会话劫持都要处理 | 手机端要做终端模拟器，体验和可靠性差 | **不推荐，除非临时远程终端** |

## 5. 每种方式的实现细节

### 5.1 Codex SDK 路线

建议架构：

```text
手机浏览器
  -> HTTPS 或受保护的 HTTP Web UI
  -> 本项目 Node 后端
  -> @openai/codex-sdk
  -> 本机 workspace
```

后端职责：

- 创建/恢复 Codex thread；
- 将 SDK async iterable 事件转成浏览器 WebSocket 或 SSE；
- 保存手机端 conversation/thread 映射；
- 将 `agent_message_delta`、命令执行、补丁应用、完成事件转成 UI 状态；
- 收到 SDK approval request 时，在手机端弹出审批卡片；
- 把手机端的 approve/deny 结果回传给 SDK；
- 限制可操作工作区，例如只允许 `/Users/ggengx/Documents/projects/before-codex`；
- 固定 sandbox/approval 策略默认值。

优点：

- 官方支持度最高，适合嵌入应用；
- 事件是结构化的，不需要解析终端文本；
- 多轮和审批是第一类能力；
- 与本项目现有 Node 20 后端技术栈匹配。

风险：

- 需要引入 SDK 依赖；
- SDK/API 的具体事件类型可能随版本演进，需要锁定版本并做兼容层；
- 需要认真设计移动端审批 UI，避免误触发高风险操作。

### 5.2 `codex app-server` WebSocket 路线

建议架构：

```text
手机浏览器
  -> 本项目安全 WebSocket 网关
  -> ws://127.0.0.1:<port>/codex
  -> codex app-server
```

关键约束：

- 只能让 `codex app-server` 监听 localhost；
- 局域网入口必须由本项目提供；
- 网关必须做鉴权、Origin 校验、CSRF 防护、速率限制和审计；
- 不要把 app-server 原始 JSON-RPC 全量透传给手机端，应该白名单化方法；
- 对 `approval/submit`、`interrupt`、`sendMessage` 等高影响方法做额外确认。

优点：

- 协议最接近完整 Codex 客户端；
- 官方方法覆盖线程、历史、输入、审批、通知和打断；
- 后续若想做“手机上的迷你 Codex UI”，这条路线功能最全。

风险：

- 官方明确无内建身份验证，不允许直接局域网暴露；
- 文档称其为 bridge/实验性能力，协议稳定性需要用版本固定和兼容测试管理；
- 实现上需要维护 WebSocket JSON-RPC 代理和状态同步。

### 5.3 `codex mcp-server` 路线

建议用途：

```text
手机浏览器
  -> 本项目后端
  -> 某个上层 Agent / Agents SDK
  -> codex mcp-server
```

这条路线适合把 Codex 当成“一个工具”交给上层 Agent 调用。例如手机端发一句“让 Agent 调 Codex 修这个 bug”，由上层 Agent 决定何时调用 Codex。它不适合直接复刻 Codex 的移动端交互体验。

优点：

- 官方 MCP 集成路径清晰；
- 适合多 Agent 编排；
- 可以与其他 MCP 工具组合。

风险：

- 多轮 Codex UI、审批 UI、事件流仍需上层系统自行设计；
- 浏览器不能直接连 stdio MCP server；
- 如果目标是“手机控制本机 Codex”，SDK/app-server 更直接。

### 5.4 `codex exec` 路线

建议架构：

```text
手机浏览器
  -> 本项目后端 job API
  -> spawn("codex", ["exec", prompt, ...固定参数])
  -> stdout/stderr 日志流
```

适合 MVP 中的最小能力：

- 手机输入任务；
- 后端创建 job；
- 后端用固定 cwd 和固定 sandbox/approval policy 执行 `codex exec`；
- 手机端实时看日志；
- 完成后查看退出码、摘要和修改文件列表。

优点：

- 实现简单；
- 与 CLI 行为接近；
- 可作为 SDK 路线出问题时的 fallback。

风险：

- 不应把手机输入拼成 shell 字符串，必须用 `spawn(command, args)` 参数数组；
- 审批和多轮能力弱；
- stdout/stderr 不是稳定 UI 协议；
- 需要限制并发，避免手机端重复点击启动多个高权限任务。

### 5.5 直接 PTY 包装路线

这条路线是：

```text
手机浏览器
  -> WebSocket
  -> node-pty / xterm.js
  -> codex TUI
```

它的唯一优势是“看起来像远程终端”，能复用 TUI。但问题也最明显：

- 手机输入法、快捷键、终端尺寸、ANSI 渲染都不稳定；
- 很难结构化识别审批、补丁、命令、错误和完成状态；
- 容易变成“局域网远程 shell”；
- 安全边界最差。

因此不建议作为本项目路线，只可作为临时本机调试工具。

## 6. 局域网暴露安全要求

### 6.1 不直接暴露 Codex 原始服务

官方 app-server 文档明确警告：该服务当前没有内建身份验证，必须绑定 localhost，不要暴露到网络。[来源：Codex app-server 文档](https://learn.chatgpt.com/codex/app-server)

因此：

- 不要让 `codex app-server` 监听 `0.0.0.0`；
- 不要用路由器端口转发暴露到公网；
- 不要把原始 JSON-RPC 方法无鉴权代理到局域网；
- 不要把 `.env`、上游 API key、Codex token、工作区文件浏览接口暴露给未认证用户。

### 6.2 移动端网关必须做的最小安全项

MVP 必须包含：

- 只允许显式启用 LAN 模式，默认继续监听 `127.0.0.1`；
- 管理端强随机 token 或一次性 pairing code；
- 手机登录态绑定到服务端 session，session 有过期时间；
- 校验 `Origin` 和 `Host`；
- 所有写操作使用 CSRF token 或同等机制；
- 审批类操作必须二次确认；
- job 并发上限，例如默认同一用户 1 个活动 Codex run；
- 工作区白名单；
- 禁止任意 shell 命令 API；
- 请求体大小、消息长度、日志保留量限制；
- 审计日志记录：谁在什么时候发起任务、批准了什么命令、修改了哪些文件；
- 页面明确显示当前工作区、sandbox/approval 模式和是否允许网络访问。

### 6.3 推荐的局域网访问模式

从低风险到高风险：

1. **本机二维码 pairing**：本机管理页显示一次性 URL/token，手机扫码后短期有效。
2. **同一 Wi-Fi + 强 token**：服务绑定局域网 IP，但必须登录。
3. **Tailscale/ZeroTier 等私有网络**：适合跨设备稳定访问，但仍需要应用层鉴权。
4. **公网暴露**：不建议。若必须做，需要 TLS、反向代理、强认证、IP allowlist、审计和自动锁定。

## 7. 推荐 MVP 路线

### 阶段 1：SDK 驱动的手机任务面板

目标：做一个“手机上能安全发任务、看进度、处理审批”的最小闭环。

建议功能：

- 在现有 Node 服务中新增可选 `lan_control` 配置；
- 默认关闭，开启后可绑定 `0.0.0.0` 或指定局域网 IP；
- 本机管理页生成一次性 pairing code；
- 手机端页面包含：
  - 会话列表；
  - 新建任务输入框；
  - 实时事件流；
  - 命令/补丁审批卡片；
  - interrupt 按钮；
  - 完成状态和修改文件摘要；
- 后端使用 Codex SDK 创建 thread/run；
- 后端保存 `mobile_session_id -> codex_thread_id`；
- 事件传输优先用 WebSocket；只看日志的页面可用 SSE；
- 默认 sandbox 使用 workspace-write，approval policy 保守设置为需要确认高风险动作；
- 所有 job 的 cwd 固定为本项目工作区或用户配置白名单。

为什么不是 `app-server` 做 MVP：

- app-server 的能力更完整，但官方安全警告更强；
- SDK 更适合被后端嵌入并自行定义安全边界；
- 本项目已经是 Node 后端，SDK 集成成本低于维护完整 JSON-RPC 代理。

### 阶段 2：兼容 `codex exec` 的轻量 job fallback

在 SDK 路线之外，可保留一个“简单任务执行器”：

- 仅允许预定义参数；
- 用 `spawn` 参数数组启动；
- stdout/stderr 转日志；
- 退出后记录 exit code；
- 不提供任意命令输入；
- 不把 PTY 暴露给手机。

用途：

- SDK 版本升级导致兼容问题时仍可使用；
- 某些一次性自动化任务不需要完整多轮 UI；
- 便于回归测试和故障诊断。

### 阶段 3：受保护的 app-server 网关

当移动端 UI 需要接近官方富客户端能力时，再引入：

- 后端启动或连接本机 `codex app-server`；
- app-server 仍只监听 `127.0.0.1`；
- 本项目做 WebSocket 网关；
- 对 JSON-RPC 方法做白名单；
- 对审批、打断、发送消息等方法做权限检查；
- 对事件做协议适配，避免手机端依赖原始协议。

这条路线适合长期演进为完整“手机 Codex 控制台”。

### 阶段 4：MCP/Agent 编排

未来如果本项目要变成“手机调度多个 Agent”，可以把 `codex mcp-server` 接到上层 Agents SDK：

- 一个 Agent 负责需求澄清；
- 一个 Agent 调用 Codex MCP 做代码修改；
- 本项目负责移动端会话、审批和审计。

这不是第一版目标。

## 8. 和当前项目的衔接

当前项目已经具备：

- Node 20 原生 HTTP 服务；
- 管理控制台；
- 登录/账号体系；
- 状态存储；
- Codex provider 配置切换；
- 调用日志和审计基础；
- 对 OpenAI Responses 流式协议的理解。

因此新增 LAN 手机控制时，建议复用：

- `src/server.js` 的 HTTP 路由；
- `src/accounts.js` 的用户/session 模型；
- `src/state.js` 或独立 mobile job store；
- 现有 admin 鉴权思路；
- 现有状态页/管理页的零构建前端模式。

不要复用或扩展的方向：

- 不要把现有 `/v1/responses` 中转接口直接当“手机控制 Codex”的执行接口；
- 不要让手机端拿到上游 OpenAI API key；
- 不要把本项目变成通用远程 shell；
- 不要把 app-server 原始端口开放到局域网。

## 9. 关键结论和来源

1. **Codex SDK 是 MVP 首选。** 官方 SDK 面向应用嵌入，支持 thread、多轮、流式事件、错误回调、审批回调和 sandbox/approval 配置。[来源：Codex SDK 文档](https://developers.openai.com/codex/sdk)
2. **`codex app-server` 能力最完整，但不能直接暴露局域网。** 官方文档称它是本地 WebSocket bridge，并明确警告没有内建身份验证、必须绑定 localhost。[来源：Codex app-server 文档](https://learn.chatgpt.com/codex/app-server)
3. **`codex mcp-server` 是 Agent 集成路线，不是浏览器 UI 路线。** 官方示例通过 Agents SDK 的 MCP client 以 stdio 启动 `codex mcp-server`。[来源：Codex MCP server 文档](https://learn.chatgpt.com/codex/mcp-server)
4. **`codex exec` 适合自动化和 CI 式非交互任务。** 官方 CLI 文档和仓库 README 都将其定位为非交互运行。[来源：Codex CLI 文档](https://developers.openai.com/codex/cli)、[来源：openai/codex README](https://github.com/openai/codex)
5. **LAN 手机控制必须默认保守。** Codex sandbox 文档说明可配置文件/网络权限，也提醒放宽 sandbox 或启用网络会增加风险；移动端入口必须加鉴权、审批和工作区限制。[来源：Codex sandbox 文档](https://learn.chatgpt.com/codex/sandboxing)

