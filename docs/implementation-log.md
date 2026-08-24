# Codex Relay 实现过程记录

最后更新：2026-08-24

这是一份过程性文档，不只记录最终代码，也记录实现时的设计判断、取舍、Bug 和验证结果。后续每次改变路由、协议兼容性或状态存储方式，都应该继续追加到这里。

## 1. 目标

第一版需要真正解决最核心的使用场景：

```text
Codex
  -> 一个稳定的中转地址
  -> 多个上游 URL
  -> 每个 URL 多个 API Key
  -> 余额/权限/限流/网络异常时自动选择其他 deployment
```

还必须把 Codex 的特殊约束放在设计中心：

- Codex 使用 OpenAI Responses API；
- Responses 的流式格式是事件式 SSE；
- 多轮请求可能携带 `previous_response_id`；
- tool call、reasoning item 和 response ID 不能在中转层被随意丢弃或重构；
- 流式响应开始后，不能把两个 Provider 的输出生硬拼在一起。

## 2. 技术选择

本机没有 Go 工具链，但有 Node.js 20。第一版选择 Node.js 原生 HTTP 和 `fetch`，原因是：

1. 不增加依赖安装和运行时准备成本；
2. Node 20 原生支持 Fetch、ReadableStream 和 `node:test`；
3. 对 HTTP/SSE 中转来说，协议层足够直接；
4. 后续如果需要高并发或多实例，可以先保持外部协议不变，再替换内部实现。

项目暂时不引入数据库、Redis、Web 框架或前端构建系统。当前规模更适合把配置文件、单进程状态和协议转发做扎实。

## 3. 目录设计

```text
src/
  classifier.js   上游错误分类和冷却时长
  config.js       JSON 配置、环境变量解析、配置校验
  errors.js       配置错误和中转错误
  index.js        启动、信号处理和启动日志
  router.js       模型解析、优先级、权重和 affinity 选择
  server.js       HTTP 路由、认证、Responses 转发
  state.js        deployment 状态、cooldown、response affinity
  status-page.js  零依赖状态页
  admin-page.js   零构建管理控制台
  codex-config.js Codex config.toml 的 provider 切换
  config-store.js 原始配置读写、密钥占位和保存前校验
  upstream.js     上游请求、响应头、SSE/JSON response ID 提取
test/
  relay.test.js   分类、普通 failover、SSE failover、affinity 测试
```

职责边界刻意保持清楚：

- `server.js` 负责 HTTP 生命周期；
- `router.js` 只决定“选谁”；
- `upstream.js` 只负责“怎么请求”；
- `classifier.js` 只判断“为什么失败”；
- `state.js` 只保存运行时状态。

这样后续接 Redis 时，可以替换 `RuntimeState`，而不用重写 Responses 协议层。

## 4. 核心设计

### 4.1 Deployment 是最小路由单元

没有把一个 Provider 只建模成一个 URL 或一个 Key，而是把下面的组合视为一个 deployment：

```text
deployment = provider + base_url + api_key + upstream_model
```

这样可以分别判断：

- 当前坏的是 Key 还是 URL；
- 同 URL 是否还有其他 Key；
- 当前模型是否可以切到另一个 Provider；
- Responses 会话应该粘到哪一个 deployment。

### 4.2 错误分类优先于重试

当前默认分类：

| 错误 | 分类 | 动作 |
|---|---|---|
| 401/403 | `credential_permanent` | 当前请求淘汰 Key |
| 402 或余额/配额文本 | `billing_or_quota` | 当前请求淘汰 Key |
| 429 | `rate_limited` | 冷却并切 Key |
| 408/5xx | `upstream_transient` | 短暂冷却并重试 |
| 网络/DNS | `upstream_transient` | 短暂冷却并重试 |
| 400/404/422 | `request_or_capability` | 默认直接返回 |

这样做的考虑是：如果任意 4xx 都触发切换，模型不存在、参数错误或工具格式错误会被错误地伪装成“Key 不可用”。

### 4.3 先在 deployment 内解决，再做 Provider fallback

请求顺序是：

```text
选择优先级最高的可用 deployment
  -> 处理 Key 级失败
  -> 处理同 Key 的临时网络失败
  -> 当前候选不可用
  -> 进入下一个 deployment/provider
```

`max_attempts` 和 `max_provider_fallbacks` 分开配置，避免重试和 fallback 叠加成不可控的请求风暴。

### 4.4 Responses affinity

成功响应中的 `response.id` 会和 deployment 绑定：

```text
response_id -> deployment_id
```

后续携带 `previous_response_id` 的请求会优先选择原 deployment。当前状态只存内存，默认 TTL 为 24 小时。

这是一个“优先亲和、允许故障迁移”的实现，而不是强制粘性：如果原 deployment 处于 cooldown，路由器仍然会尝试其他可用 deployment。对于带加密 reasoning item 的 Provider，未来需要进一步增加迁移能力判断。

### 4.5 SSE 故障转移

当前将流式请求分为两个阶段：

1. **首个有效事件之前**：允许尝试下一个 deployment；
2. **首个有效事件之后**：只转发当前流，不拼接第二个 Provider。

这是为了避免：

- 重复输出；
- response ID 不一致；
- tool call ID 不一致；
- 已经计费后再次完整请求；
- Codex 消费到半个无效 Responses 流。

## 5. 实现阶段

### 阶段一：骨架和配置

已完成：

- Node.js 原生项目；
- JSON 配置；
- `env:NAME` 和 `${NAME}`；
- 配置校验；
- 缺失配置的可读错误；
- 示例配置。

设计心得：配置格式先追求“错误可读、密钥不落盘、无需额外依赖”，而不是一开始追求支持所有格式。

### 阶段二：路由和状态

已完成：

- 模型名和 alias 解析；
- priority；
- weight；
- deployment enabled；
- cooldown；
- 请求级 attempts；
- response affinity；
- 运行时状态快照。

设计心得：优先级比复杂的自适应评分更适合第一版。只有在有真实请求数据后，才值得引入延迟、失败率或成本评分。

### 阶段三：Responses 和 SSE

已完成：

- `/v1/responses`；
- 非流式 JSON 转发；
- `stream=true`；
- event-based SSE 转发；
- upstream response ID 提取；
- `previous_response_id` affinity；
- 上游模型名重写。

设计心得：中转层默认尽量透传 body，不主动把 Responses 转成 Chat Completions。协议转换会显著扩大 Codex 兼容风险。

### 阶段四：易用性

已完成：

- `/v1/models`；
- `/healthz`；
- `/readyz`；
- `/api/status`；
- `/api/status/public`；
- 零依赖状态页；
- `x-relay-request-id`；
- JSON 结构化日志；
- README 启动和 Codex 配置示例。

### 阶段五：Provider 规则和配置热加载

本阶段完成了两个直接影响日常运维体验的能力。

#### 5.1 Provider-specific 错误规则

不同上游对“余额不足”“限流”和“凭证失效”的 HTTP 状态码并不总是一致。仅依赖通用 401/402/403/429/5xx 规则，会出现两个风险：

- 上游用 400 或 409 表示余额不足时，中转站错误地把它当成用户请求错误；
- 上游用特殊错误 code 表示限流时，中转站无法切换 Key。

因此新增了 `routing.provider_error_rules`。每个 Provider 可以配置：

- `*_statuses`：HTTP 状态码；
- `*_codes`：结构化错误 code/type；
- `*_messages`：错误消息片段；
- `non_retryable_statuses`：明确禁止 failover 的状态码。

匹配顺序是：

```text
Provider 自定义 non-retryable
  -> Provider 自定义 auth/billing/rate-limit/transient
  -> 通用默认规则
```

自定义规则只需要覆盖 Provider 的差异部分，未命中的情况仍回退到通用规则，避免配置重复和升级时行为突然改变。配置校验会拒绝错误的数据类型，例如把状态码写成字符串或把消息规则写成对象。

#### 5.2 配置热加载

新增受保护的 `POST /admin/reload`。实现采用“先加载、后替换”的顺序：

1. 从原配置路径读取文件；
2. 解析 JSON、解析环境变量并执行完整校验；
3. 校验成功后，原地清空并更新当前配置对象；
4. 校验失败时不修改当前配置。

`Router` 保存的是配置对象引用，因此原地更新可以让现有 server 和 router 立即看到新模型、新 deployment、新 Key 和新规则，不需要重建 HTTP server。`RuntimeState` 不参与替换，所以 cooldown、请求统计和 `response_id -> deployment` affinity 会继续保留。

这也明确了热加载的边界：`server.host` 和 `server.port` 会影响后续逻辑读取，但已经监听的 socket 不会迁移，因此监听地址或端口变化仍需重启。

管理接口返回 `reloaded_at`、模型数和 deployment 数，方便脚本或状态系统确认 reload 是否真正生效。鉴权失败返回 401，配置解析或校验失败返回 400，且旧配置继续服务。

### 阶段六：请求生命周期和流式故障语义

这一阶段把“请求已经开始之后发生什么”定义清楚，并用本地 HTTP 上游做了回归测试。

#### 6.1 超时覆盖完整响应生命周期

之前的 timeout 清理发生在 `fetch()` 收到响应头之后。对于上游返回 200 但迟迟不发送 body，或者 SSE 已经建立但迟迟没有首个事件的情况，`request_timeout_ms` 实际上没有生效。

现在 `callUpstream()` 返回响应和 cleanup 函数，直到非流式 body 完整读取或 SSE 转发结束后才清理计时器。因此超时覆盖：

```text
连接建立
  -> 等待响应头
  -> 读取非流式响应体
  -> 读取 SSE 首事件
  -> 读取 SSE 终止事件
```

#### 6.2 客户端取消

客户端取消通过 `req.aborted` 和 relay `ServerResponse.close` 双重观察。正常请求体上传完成时不会把普通 `close` 误判为取消；只有 response 尚未正常结束时的 close 才会中止上游。

客户端主动断开时：

- 上游 fetch 会被 AbortController 中止；
- 不会把 deployment 记为失败；
- 不会切换到备用 Key 或 Provider；
- 不会尝试向已经断开的客户端写入 499 响应。

这符合“取消是调用方行为，不是上游健康问题”的判断。

#### 6.3 SSE 正常结束和断流

SSE reader 返回 `done=true` 本身不能证明 Responses 流已经完整结束，因为 TCP/HTTP 连接也可能在中途干净关闭。因此中转站会持续识别最近的 SSE 内容，只有看到以下终止信号才记录成功：

- `response.completed`；
- `response.failed`；
- `response.incomplete`；
- `[DONE]`。

首个有效事件之前断流仍然允许 failover。首个有效事件之后没有终止信号的断流会冷却当前 deployment，但不会拼接另一个 Provider 的流，避免重复计费和破坏 Responses item 顺序。

### 阶段七：可替换状态后端和同机多实例

本阶段没有把 Redis 直接引入项目，而是先把 `RuntimeState` 和状态存储解耦：

```text
Router / server
  -> RuntimeState
  -> StateStore
       -> MemoryStateStore（测试/临时）
       -> FileStateStore（默认，同机多实例）
```

这样保留了当前同步、零依赖的调用方式，同时为后续 Redis/数据库后端留下稳定边界。

#### 7.1 内存状态

`state.store = "memory"` 适合测试和临时运行，读写速度最好，但进程重启后 cooldown、统计、cursor、最近调用和 affinity 都会清空。

#### 7.2 文件状态

当前默认使用 `state.store = "file"`。如果没有显式配置 `state.file_path`，默认写入项目根目录的 `.codex-relay-state.json`。多个 relay 实例使用同一个文件时，可以共享：

- deployment cooldown；
- attempts、successes、failures；
- `response_id -> deployment` affinity；
- weighted routing cursor；
- 最近调用日志；
- 按天聚合的 token、调用量、失败数和延迟统计。

写操作使用 lock 目录互斥，数据写入采用临时文件加 rename；读操作不落盘，避免健康检查和状态页频繁改写文件。状态文件只包含运行时元数据，不包含 API Key，但会包含最近响应预览和错误摘要，因此仍应设置合适的本机文件权限。

这个方案的边界是明确的：

- 适合同机多进程；
- 适合挂载同一份可靠共享卷的低到中等并发场景；
- 不把文件锁当作跨机器分布式一致性协议；
- 跨节点生产部署仍应接入 Redis 或数据库。

`/admin/reload` 只替换业务配置，不替换已经创建的 StateStore。因此修改 `state` 配置需要重启，这可以避免 reload 过程中出现一半请求读旧后端、一半请求读新后端的混合状态。

### 阶段八：网页管理控制台和配置热更新

用户提出新的易用性目标：日常操作尽量不再编辑文件，而是在网页端完成。

本阶段新增了 `/admin` 管理控制台和三类管理 API：

- `GET /admin/config`：读取可编辑配置、运行状态和 Codex provider 状态；
- `PUT /admin/config`：保存配置文件并立即热更新运行时；
- `GET/POST /admin/codex-config`：读取或切换 `~/.codex/config.toml` 的 `model_provider`。

#### 8.1 为什么不直接回写运行时 config

运行时配置已经经过环境变量解析，例如 `env:UPSTREAM_A_KEY_1` 会变成真实 key。如果直接把运行时对象返回前端或写回磁盘，会把环境变量里的密钥落到 `config.json`。

因此新增 `config-store.js`，专门读取原始 JSON 文件。返回给前端前会做密钥占位：

```text
real-upstream-key -> secret:deployment:<id>:api_key
admin-secret      -> secret:server:admin_api_key
```

保存时如果占位符没有被改动，就从旧配置中恢复原值；如果用户填了新的 `env:NAME` 或真实 key，就按新值保存。

#### 8.2 保存顺序

网页端保存不是“先覆盖文件再 reload”，而是：

1. 读取旧配置；
2. 恢复没有改动的密钥占位符；
3. 写入临时配置文件；
4. 用现有 `loadConfig()` 完整解析和校验临时文件；
5. 校验成功后 rename 覆盖原配置；
6. 原地替换运行时 config；
7. 返回新的状态快照。

这样可以避免无效配置把服务带入半更新状态。

#### 8.3 Codex provider 切换

新增 `codex-config.js`，只处理非常小的 TOML 子集：

- 顶层 `model_provider = "openai"` 或 `"relay"`；
- `[model_providers.relay]` 区块；
- relay 的 `base_url`、`wire_api` 和 auth command。

当用户在网页端选择 `openai`，会更新顶层 `model_provider`，Relay 继续运行但 Codex 不再使用它。当用户选择 `relay`，会确保 relay provider 区块存在并指向当前中转站 `/v1` 地址，同时写入本地 `relay-token.mjs` auth command，让 Codex 自己从 `.env` 读取内部 relay token。

#### 8.4 前端设计

第一版选择零构建、零依赖的内嵌 HTML/CSS/JS，原因是：

- 项目本身没有包管理依赖；
- 管理后台只服务本机/内网用户；
- 避免引入前端构建链后增加启动和部署成本。

界面分两层：

- Quick：常用操作，切换 Codex provider、选择模型、增删 API、启停 API、设置 API key/model_provider/base_url/model；
- JSON：完整编辑原始配置，覆盖高级路由、cooldown、provider error rules、state 后端等详细配置。

“Only This” 操作用来快速只启用某一个 API；普通 Enable/Disable 则适合保留多个 API 作为 failover 池。

### 阶段九：多用户注销与 token 撤销

用户反馈了一个很关键的同机多用户风险：用户 A 登录并配置 API 后，如果只是在前端或 CLI 清掉本地显示状态，下一个使用机器的人仍可能通过旧 token、终端 session 文件或默认账号继续使用用户 A 的 API。

本阶段把 `logout` 从“清除本地 UI/session”升级为真正的安全边界：

- `AccountStore.logout()` 会清除当前终端 session；
- 如果注销账号正好是免登录默认账号，会同步清除 `default_username` 和所有 `is_default` 标记；
- 注销时轮换账号 `api_token`，让已经暴露给 Codex、网页端或手机端的旧 bearer token 立即失效；
- 网页端 `Logout` 调用 `POST /admin/account/logout`，后端成功后才清理浏览器 `localStorage`；
- 手机端 `Logout` 调用 `POST /mobile/logout`，避免手机上的旧 token 留存可用；
- CLI 的 `npm run cli logout` 和交互式 `Account & session -> Logout` 都走同一套 `AccountStore.logout()`。

这里有一个容易漏掉的边界：`scripts/relay-token.mjs` 是 Codex 真正启动请求时读取 bearer token 的入口。之前它的顺序是“当前终端 session -> 默认账号 -> Guest `.env` token”。现在如果 session 文件存在但 token 已经被撤销，它会认为这是一个失效的显式登录状态，直接提示重新登录，而不是回退到默认账号。这样可以避免用户 A 注销后，用户 B 在同一个终端里无感继承某个默认账号。

设计取舍：当前账号模型每个用户只有一个 `api_token`，所以注销会让该账号在其他已登录终端里的旧 token 一并失效。这比只清当前浏览器更严格，但符合“同一台电脑多人使用时，退出后不能继续用这个人的 API”的安全预期。后续如果需要“只注销当前设备、不影响其他设备”，可以把账号 token 拆成多条命名 session token，并在账号记录里维护 token 列表和设备来源。

### 阶段十：Global / Terminal 作用域

第一阶段没有引入 PID 级 Process scope，而是使用已有的终端 session 标识作为 Terminal scope。网页管理台新增作用域栏：

- `Global`：设置或清除全局默认账号。没有显式终端 session 的 Codex 会使用这个账号；清除后回到 Guest；
- `Terminal`：把当前网页选择的 Guest 或账号绑定到输入的 `session_id`。Codex 的 `relay-token.mjs` 在对应终端里会优先命中这个绑定；
- Guest 的 Terminal 绑定使用一个明确的 guest marker，因此不会因为机器上存在另一个默认账号而错误继承它；
- `Save + Reload` 会连同当前选择的作用域一起提交，`Apply Scope` 可以只修改绑定关系而不保存配置。

这里的 `session_id` 对应 `RELAY_SESSION_ID`、`ITERM_SESSION_ID`、`TERM_SESSION_ID` 或 `WT_SESSION`。网页进程无法自动读取打开它的 shell 环境，所以网页端允许手工填写，也会把已有 session 列在下拉提示中。当前阶段仍然是账号级配置：Terminal scope 改变的是“这个终端使用谁”，不是为同一个账号创建一份独立 API 配置副本。

## 6. 遇到的 Bug 和修复

### Bug 1：成功响应被提前中止

现象：

- 上游返回 200；
- 日志显示 `upstream_success`；
- 客户端收到空 body；
- 测试无法匹配响应 ID。

原因：

`forwardResponse()` 先调用 `writeHead()`，然后又调用 `setHeader("content-length", ...)`。Node.js 在 `writeHead()` 后已经提交 headers，后续设置 header 会抛出异常并中断响应。

修复：

- 先决定最终 body；
- 在 `writeHead()` 的 header 对象中设置 `content-length`；
- 再一次性 `res.end(body)`。

心得：

HTTP 转发代码里，header 提交时机是行为的一部分，不能把“设置 header”和“发送 header”混在一起。

### Bug 2：正常请求上传完成被误判为客户端断开

现象：

- 上游响应已经返回；
- 读取 response body 时出现 `upstream_network_error`；
- 测试进程表现为连接未正常结束。

原因：

最初使用 incoming request 的 `close` 事件来中止上游 fetch。但 Node.js 的 `close` 也可能在客户端正常结束请求体上传后触发，不代表客户端取消了整个请求。

修复：

- 改用 `req.aborted` 判断客户端是否真的取消请求；
- 保留 `close` 不作为取消信号。

心得：

Node.js HTTP 的 request 生命周期事件语义很细，做流式代理时必须用正确的事件，否则正常流量会被当成取消。

### Bug 3：失败测试留下监听中的服务器

现象：

- 断言失败后，测试进程继续运行；
- 临时 upstream server 没有关闭。

原因：

清理代码位于断言之后，断言失败时不会执行。

修复：

- 将临时服务器清理移动到 `try/finally`；
- 确保 relay 和 fake upstream 无论断言成功或失败都关闭。

心得：

端到端测试不仅要验证结果，也要管理资源生命周期，否则一次失败会污染后续调试。

### Bug 4：公开状态页暴露 endpoint

现象：

最初状态快照同时被公开状态页和管理 API 使用，其中包含上游 URL origin。即使没有暴露 Key，这也超过了公开状态页的必要信息范围。

修复：

- `RuntimeState.snapshot()` 增加 `includeEndpoint` 选项；
- `/api/status/public` 默认不包含 endpoint；
- `/api/status` 仅在 admin token 校验通过后包含 endpoint origin。

心得：

状态接口应该按受众分层：公开状态只回答“是否健康”，管理接口才回答“哪个 deployment 为什么失败”。

### Bug 5：自定义 logger 没有覆盖转发日志

现象：

- 测试创建 server 时传入了静默 logger；
- 请求转发仍然在测试输出结构化日志。

原因：

`createRelayServer` 已经接收 logger，但 `relayResponses` 内部直接调用了模块级默认 logger，没有把依赖继续传入。

修复：

- 将 logger 作为 `relayResponses` 的显式参数；
- 所有上游成功、失败和流中断日志统一使用传入的 logger。

心得：

可注入的依赖必须沿调用链传递到底，否则接口看起来可配置，实际行为却不一致，也会让测试信号变差。

### Bug 6：SSE 连接关闭被误认为成功

现象：

- 上游发送了 `response.created`；
- 随后直接关闭连接；
- 中转站将 deployment 标记为 healthy。

原因：

ReadableStream 的 `reader.read()` 在连接干净关闭时可能返回 `done=true`，并不一定抛出异常。仅依赖异常捕获无法识别“没有 response.completed 的半截流”。

修复：

- 增加 `sseHasTerminalEvent()`；
- 缓存最近 8KB 的 SSE 文本；
- 只有识别到 Responses 终止事件或 `[DONE]` 才记录成功；
- 首事件后的异常断流记录 `upstream_stream_closed_after_commit`，并保留“不跨 Provider 拼流”的策略。

心得：

流式协议的“连接结束”和“业务消息结束”是两个不同层次的状态，代理必须同时理解 transport 和 protocol。

### Bug 7：网页配置保存可能泄露真实密钥

风险：

管理接口如果直接返回当前运行时 config，`env:NAME` 已经被解析成真实 key。用户只是打开网页或点击保存，就可能把真实 key 写入浏览器状态或落盘到 JSON。

修复：

- 管理接口读取原始 `config.json`；
- 对直接写在配置中的 key 使用 `secret:*` 占位符；
- 保存时对未改动占位符恢复旧值；
- 测试断言响应体不包含真实上游 key。

心得：

配置热更新的易用性不能牺牲密钥边界。控制台越方便，越需要把“展示值”和“存储值”分开。

### Bug 8：每次手动 export 环境变量太繁琐

现象：

用户每次启动服务都需要重新 `export RELAY_API_KEY`、`RELAY_ADMIN_KEY` 和多个上游 Key。进一步看，第一次填写这些 Key 也应该能在网页端完成。

修复：

- 新增零依赖 `.env` 加载器；
- 默认启动时读取项目根目录 `.env`；
- 支持 `npm start -- --env /path/to/.env` 和 `RELAY_ENV=/path/to/.env`；
- shell 里已经存在的环境变量优先生效，不被 `.env` 覆盖；
- 缺少 server/admin Key 和 deployment API Key 时，服务仍可启动进入本机初始化；
- 新增 `/admin/env`，网页端可以填写 Secrets 并写入 `.env`；
- 新增 `.env.example`，`.env` 继续留在 `.gitignore`。

心得：

配置里的密钥引用仍然保留 `env:NAME`，但用户不需要每次手动 export。把“密钥不落配置文件”和“启动不折腾”同时满足，体验会顺很多。

### 功能 9：可视化看板和滑块配置

用户希望网页端更直观地展示最近调用、各 API token 用量，并把 `priority`、`weight` 做成可拖动调节。中途曾评估并实现过强度映射，但后续决定撤回：Codex 的模型强度继续作为原始请求参数透传给上游，中转站不按强度自动改写真实模型。

实现心得：

- 出站请求改写继续集中在 `requestBodyForDeployment`，避免模型覆盖逻辑散落；
- runtime state 增加 `last_request`、`token_usage` 和 `recent_calls`，管理页可以展示最近调用和 token 累计；
- priority 与 weight 改为滑块：priority 负责顺序，数值越小越先尝试；weight 只在同 priority 内决定分流比例；
- 管理页新增运行看板，让路由状态和 token 观测能在网页端完成。

遇到的小问题：

- 前端仍是单文件模板字符串，内联事件里的引号容易出错；本次继续用 `node --check` 兜底；
- token 用量依赖上游 Responses 返回的 `usage` 字段。非流式响应可以稳定解析，SSE 会从尾部事件中尽量提取，若上游不返回 usage，则看板显示 0。

### Bug 10：网页输入框每次只能输入一个字符

现象：

API 卡片里的 `api_key`、`base_url`、`model` 等输入框每输入一个字符就失焦。原因是 `setDeployment()` 在 `oninput` 里每次都调用 `renderApis()`，导致整张 API 列表被重新生成。

修复：

- 文本输入和滑块拖动只更新内存中的配置和 JSON 编辑器；
- 只有启用/禁用、删除、Only This、刷新等结构性操作才重绘 API 列表；
- 滑块的数值显示直接更新相邻 `output`，不依赖整块重绘。

心得：

表单输入期间最重要的是保持 DOM 稳定。配置面板这类工具页，不应该为了同步显示牺牲基础编辑体验。

### 功能 10：测试模型与调用详情

新增 `/admin/test-deployment`，网页端每个 API 卡片都有 `Test` 按钮。测试行为采用“保存并热加载后测试”的顺序，避免用户看到的是新表单，服务实际测试旧 runtime 配置。

同时最近调用日志增加返回文本预览：

- 成功调用记录 `response_text`、真实上游模型、耗时和 usage；
- 测试失败也会进入最近调用，方便看到错误摘要；
- 网页端 `Logs` 支持点击最近调用打开详情弹层；
- 返回文本截断保存，避免状态文件无限增长。

### 功能 11：日志分页、详情 JSON 和模型看板

用户反馈日志列表太大、太显眼，并且记录多了以后会拉长页面。于是把 Quick 工作区拆为三个内部 Tab：

- `Overview`：展示 total tokens、calls、avg latency、recent failures，并按真实上游模型聚合 token、健康 deployment 数、成功/失败数和平均延迟；
- `Logs`：固定高度滚动列表，单条日志更紧凑，不再挤压 API 配置区；
- `APIs`：只保留 API 编辑、测试、priority/weight 调节。

调用详情弹层新增 `Summary / JSON` 两种视图。Summary 面向日常查看，JSON 面向排查问题和复制完整日志。

后续继续补上 `GET /admin/calls?offset=&limit=`，Logs 页通过该接口分页查询最近调用。状态层保留最近 500 条记录，避免调用变多后页面无限增长。

### 功能 12：Codex threads provider 同步

用户希望在网页端切换 `openai` / `relay` 时，不只修改 `~/.codex/config.toml`，还要同步 `~/.codex/state_5.sqlite` 中 `threads` 表所有 thread 的 `model_provider` 字段。

实现：

- 新增 `defaultCodexStatePath()`，默认指向 `~/.codex/state_5.sqlite`；
- `writeCodexModelProvider()` 写完 TOML 后调用 sqlite3；
- 执行 `UPDATE threads SET model_provider='<provider>'`；
- 接口响应返回 `threads.updated` 和 `threads.total`，网页端用 notice 告知用户同步结果；
- `Save + Reload` 保存配置后也会同步当前网页端选中的 provider；
- 测试使用临时 sqlite 文件，避免碰真实 Codex 状态库。

心得：

这是一个“网页操作需要同时改配置文件和历史状态库”的典型桌面工具需求。为了保持项目零依赖，先用系统 `sqlite3` 命令实现；如果后续跨平台分发，需要考虑打包 sqlite runtime 或引入受控依赖。

### 功能 13：持久化统计、周/月/年图表和隐藏内部 Key

用户反馈 token 统计不应该因为浏览器或服务重启而丢失，并希望看板有周视图、月视图、年视图以及更直观的图表。同时，`RELAY_API_KEY` 和 `RELAY_ADMIN_KEY` 对普通使用者来说更像内部实现细节，不应该出现在网页 Secrets 表单里。

实现：

- `RuntimeState` 增加 `daily_usage`，以日期为 key 聚合 total/input/output tokens、calls、failures 和 latency；
- 成功调用和测试调用失败都会进入最近调用，并同步更新当天 usage bucket；
- `usageSummary()` 输出 week/month/year 三组统计，`/api/status` 和 `/admin/config` 一并返回；
- 默认状态后端改为 file，默认路径为 `.codex-relay-state.json`，让 token 统计、调用日志、cooldown 和 affinity 跨服务重启保留；
- 管理页 Overview 增加 `Week / Month / Year` 切换、Token Activity 图表和 Model Comparison；
- 启动时自动生成缺失的 `RELAY_API_KEY` / `RELAY_ADMIN_KEY` 到 `.env`；
- 本机访问 `/admin` 时自动注入 admin token，隐藏登录框；
- Secrets 列表过滤内部 key，只显示上游 key；
- 左侧 `Model Add` 改为 `Routes / Add Route`，强调它是 Codex 请求模型名到真实上游 API 组的映射，而不是“新增一个上游模型参数”。

设计心得：

统计看板的核心不是堆更多数字，而是把“我刚刚实际调用了哪个模型、花了多少 token、哪个模型更慢或更容易失败”做成用户一眼能判断的反馈。内部 relay key 仍然保留，因为 Codex 到 relay、浏览器到管理接口需要基本鉴权；但对本机桌面用户，它们应该由系统生成和消费，而不是成为日常配置负担。

遇到的小问题：

- 旧文档仍然鼓励用户手动 `export RELAY_API_KEY`，这会和新的 auth command 心智模型冲突，已改为网页端切换 provider 优先；
- 默认文件状态会写入运行时响应预览，因此虽然不保存 API Key，仍需要把 `.codex-relay-state.json` 放进 `.gitignore`；
- 日视图信息密度太低，已移除；月视图不再强行显示 30 个挤压日期，年视图改为类似 GitHub contribution 的热力图；
- usage 保留时间扩展到 370 天，支持完整年视图；
- 最近调用保留上限扩展到 500 条，并新增 `GET /admin/calls?offset=&limit=` 供 Logs 分页查询。

## 7. 当前验证结果

截至 2026-08-21：

```text
npm run check 通过
npm test       36 个测试通过
```

已覆盖：

- 402 配额错误分类；
- Provider-specific billing/rate-limit/non-retryable 规则；
- 普通 Responses 请求的 Key failover；
- SSE 首个事件前的 Provider failover；
- `response_id -> deployment` affinity。
- 公开状态接口不暴露上游 endpoint。
- reload 鉴权、成功更新、失败回滚和运行时 affinity 保留。
- SSE 终止事件识别；
- SSE 首事件前断流、超时和首事件后断流；
- 非流式响应体超时；
- 客户端取消不会重试或冷却 deployment。
- 文件状态后端的 cooldown、affinity、统计和 cursor 跨实例共享；
- 文件状态配置校验。
- 管理配置 API 的密钥占位、保存和热更新；
- Codex `model_provider` 在 `openai` 和 `relay` 间切换。
- `.env` 解析和加载，且不覆盖已有 shell 环境变量。
- 缺失 env 时仍可启动，网页端保存 Secrets 后热加载运行时配置。
- 成功调用会记录 token 与最近调用，用于网页端 Overview/Logs。
- 管理端测试 deployment 会记录返回文本和 usage。
- Provider 切换会同步临时 sqlite threads 表的 `model_provider` 字段。
- 默认 file state 会持久化按天 token 统计，重启后 week/year usage 仍可读取。
- 管理页隐藏内部 relay/admin key，只展示上游 env 引用。
- Overview 的 Week/Month/Year 图表可切换，年视图热力图、日志分页和详情弹层不产生横向溢出。
- `/admin/calls` 支持 offset/limit 分页查询最近调用。
- 请求侧会过滤 replay 历史里的非法 reasoning item，避免 `item_*` 被发送给严格上游。
- 非流式 Responses 响应会过滤非法 reasoning item，避免继续污染 Codex 本地历史。
- Responses SSE 事件会过滤非法 reasoning item，同时保留可转发的 message 和 completed 事件。
- Relay 的 Logs 现在会记录 retryable failover 的中间失败尝试，不只记最终成功。
- `/v1/models` 同时返回 `data` 和 Codex CLI 期望的 `models`，并为每个模型补充 `slug`、`display_name`、reasoning levels 等 Codex 模型管理器需要的元数据。
- 流式请求在 Codex CLI 已收到输出后主动断开时，会写入成功调用日志，避免用户看到 CLI 有结果但 Logs 不更新。
- SSE 文本提取兼容 `delta`、chat-completions `choices[].delta.content`、Responses `item.content` 和 `response.output` 等常见形态。
- 当配置中只有一个逻辑模型时，Codex 侧传来的未知模型名会自动落到这个默认逻辑模型，真实上游模型仍由 deployment 的 `model` 决定。
- 当上游没有返回 `usage` 时，Relay 会按请求文本和返回文本做粗略 token 估算，并在调用记录和持久化统计中标记 `estimated: true`；估算值只用于看板趋势，不应作为账单依据。对于明显像 base64 / opaque blob 的长串响应，Relay 会保守处理，避免把整串误算成自然语言 token。
- Logs 改为真正的分页视图：服务端按 `offset + limit` 返回，前端支持首页、上一页、下一页、末页和每页 10/20/50 条切换，列表不再依赖一个大滚动容器。

## 9. 本机多用户账号与 CLI

### 需求

同一台机器可能由多个用户使用。每个用户需要自己的 API、路由、调用日志和 token 统计，同时希望登录动作只影响当前终端；没有登录时，也可以选择一个免登录默认账号。

### 设计

- `src/accounts.js` 负责账号生命周期、密码 hash、用户 token、终端 session 和默认账号；密码使用 Node `scryptSync`，不保存明文密码。
- 每个账号独立保存 `config.json` 和 `state.json` 到 `~/.codex-relay/users/<username>/`；注册时不会复制全局配置里的真实 API key，而是生成禁用的空 profile，要求用户主动填写自己的 key。
- `scripts/relay-token.mjs` 按优先级读取当前终端 session、免登录默认账号、旧版 `.env` 全局 token。macOS Terminal/iTerm 的 session 环境变量用于区分不同终端。
- Relay 的 `/v1/models` 和 `/v1/responses` 收到用户 token 后，会加载对应 profile 和 state；注册过账号后，旧全局 token 不再绕过账号隔离。没有任何账号时保留旧单用户兼容模式。
- `src/cli.js` 使用 Node 原生 readline 和 ANSI 彩色输出，覆盖注册、登录、注销、删除、默认账号、API/route 编辑、测试、看板、日志和 Codex provider 切换，不额外引入 CLI 依赖。

### 遇到的问题与修复

- 初版用户 profile 直接 clone 全局配置，会意外继承全局 API key；改成注册时清空 key 并禁用 deployment。
- profile 请求路径第一次集成测试暴露 `server.js` 漏引入 `createRuntimeState`，补充 import 后修复。
- 测试账号公开信息不能包含 api token；token 只从内部认证记录和受保护本地文件取得。
- 账号模式不能继续接受旧 global key 作为绕过凭证，否则用户隔离没有意义；改为“有账号则只接受用户 token，无账号才兼容旧模式”。

### 当前验证

```text
npm run check 通过
npm test       39 个测试通过
```

新增覆盖：账号注册/密码认证、session 隔离、默认账号、token 轮换、账号删除，以及真实 relay 请求按用户 token 路由到独立 profile。

## 8. Responses item ID 兼容过滤

### 背景

在 Codex 长会话中，第三方 OpenAI-compatible Provider 可能返回非官方格式的 Responses item ID。典型问题是：

```text
Invalid 'input[324].id': 'item_...'. Expected an ID that begins with 'rs'.
```

本地排查确认过一种污染形态：上游把 `type: "reasoning"` 的 item 返回成 `id: "item_..."`。Codex 会把它写入 rollout 历史；后续切回官方 OpenAI 或严格兼容的上游时，历史 replay 会把这条非法 reasoning item 再发出去，最终被拒绝。

### 设计

本次实现选择“过滤非法 reasoning item”，而不是把 `item_*` 伪造成 `rs_*`。原因是 reasoning item 通常代表上游内部状态，第三方生成的 opaque state 即使换了前缀，官方 OpenAI 也不一定认识。

新增默认开启的兼容配置：

```json
{
  "routing": {
    "compatibility": {
      "sanitize_request_items": true,
      "sanitize_response_items": true,
      "drop_invalid_reasoning_items": true,
      "strip_invalid_request_item_ids": true,
      "strip_invalid_response_item_ids": true
    }
  }
}
```

也可以在单个 deployment 上覆盖 `compatibility`。

### 行为

- 请求侧：当 Codex replay 的 `input` 数组中出现 `type: "reasoning"` 但 ID 不是 `rs*` 时，转发上游前移除该 item。
- 请求侧：普通 `message`、`function_call`、`function_call_output` 如果带有明显错误的第三方 `id`，会去掉 `id`，但保留内容和 `call_id`。
- 响应侧：非流式 JSON 响应中的非法 reasoning item 会被移除，避免再次写入 Codex 本地历史。
- 响应侧：普通 `message`、`function_call`、`function_call_output` 如果带有明显错误的第三方 `id`，会去掉 `id`，避免污染后续 compact/replay 历史。
- 响应侧：SSE 中的非法 reasoning item 事件会被丢弃，`response.completed` 里的 `output` 数组也会同步清理。

### 心得

这类兼容层最容易犯的错是“修前缀”。但 Responses item ID 不是纯展示字段，它可能参与后续状态恢复。中转站更适合做协议防火墙：丢弃明确非法、不可移植的 provider state，保留用户消息、工具输出和可读文本。

### 2026-08-22 复发：message item id 前缀错误

后续又遇到相同家族的错误，但类型从 reasoning 变成了 message：

```text
[ApiIdParam] [input[286].id] [invalid_id_prefix] Invalid 'input[286].id': 'item_200f953b826354e8132eb110'. Expected an ID that begins with 'msg'.
```

原因是第一次修复主要挡住非法 reasoning item，以及请求侧 replay 中的错误 item id；但响应侧仍可能把第三方返回的 `type: "message", id: "item_*"` 原样交给 Codex。Codex 将其写入本地历史后，后续 compact 或切换到更严格上游时仍会失败。

修复：

- 新增默认开启的 `strip_invalid_response_item_ids`；
- 非流式 Responses payload 会去掉 message/tool item 上错误的第三方 `id`；
- Responses SSE 事件也会在转发前清理 `item.id` 和 `response.output[].id`；
- 增加非流式和 SSE 两条回归测试，覆盖 `Expected an ID that begins with 'msg'` 这一形态。

## 9. 当前未完成项

这些不是当前版本隐藏的行为，而是明确保留的后续工作：

- Redis/数据库状态后端；
- 余额主动探测；
- 更严格的 `response.failed` 事件诊断；
- 访问限流和 RBAC；

## 10. 下一步建议

下一阶段优先级：

1. 增加真实上游的 Responses/SSE 回归样例；
2. 增加余额主动探测和更细的 `response.failed` 诊断；
3. 接入 Redis/数据库状态后端，支持跨机器多副本；
4. 给管理 UI 增加访问限流、RBAC 和更完整的表单校验。

当前实现的核心心得：

> 先把 Codex 能否稳定完成一次 Responses 会话做正确，再扩展成通用 LLM 平台。

## 11. Test API 交互反馈与重复提交修复（2026-08-23）

### 问题

管理页面的 `Test` 请求可能需要较长时间，但按钮点击后没有 loading 状态，也没有防重复提交机制。用户连续点击会并发发起多个相同测试请求；请求异常时只有顶部通知，无法直接查看测试结果详情。

### 设计

- 使用 `testingDeployments` Set 按 deployment ID 维护测试中的 API；不同 API 可以并行测试，同一个 API 只允许一个测试请求。
- 点击后立即重绘当前 API 卡片，将按钮改为 `Testing...` 并禁用，同时显示顶部状态通知。
- 成功和失败都通过既有的 `Test Result` 详情弹窗展示，保留状态、模型、耗时、usage、返回内容或错误信息。
- 使用 `finally` 释放锁并恢复按钮，确保保存失败、上游失败和成功响应都不会让按钮永久卡住。

### 心得

耗时操作的反馈必须在请求发出前就更新 UI；只在请求结束后刷新页面，会让用户误以为点击没有生效。锁定粒度放在单个 deployment，而不是全局，可以同时保留多 API 的测试效率。

## CLI 控制台重做（2026-08-23）

### 问题

初版 CLI 是 `readline.question()` 加数字菜单。它能覆盖功能，但操作是线性的：用户需要记住命令数字，编辑没有字段光标，无法在页面之间返回，也没有稳定的长操作反馈。这种交互不适合多用户反复维护 API 配置。

### 设计

- 使用 Node 原生 `readline.emitKeypressEvents()` 和 raw mode，避免增加 CLI 依赖；
- 把 CLI 建模为页面状态机：Welcome、Control center、APIs、Routes、Logs、Call detail、Overview、Provider、Account 和 Form；
- 用 `backStack` 保存页面路径，统一由 `Esc` 返回；表单取消不会写盘；
- 列表有明确的绿色 `>` 高亮项，`↑↓` 移动，`Enter` 打开；日志使用固定页大小并支持左右翻页；
- 表单同时维护字段索引和文本光标，API key 用掩码显示，`Ctrl+X` 清空字段，`Ctrl+S` 保存；
- 测试、保存、provider 切换和 relay reload 都在开始异步操作前刷新状态栏，并锁定按键处理；
- 按键事件使用队列顺序处理，避免用户快速按下“下一个 + 回车”时丢失第二个按键；异步操作期间到达的按键直接丢弃，避免测试完成后重复执行积压操作；
- API/profile 保存先写临时文件并用 `loadConfig()` 校验，校验失败保留原配置；成功后尝试调用 `/admin/reload`，relay 未运行时仍保留已保存配置并给出明确提示。

### 交互结果

```text
Control center
  > Overview
    APIs & keys
    Routes / aliases
    Recent logs
```

CLI 不再要求用户记住 `1/2/3` 菜单。用户可以在编辑 API 的任意字段按 `Esc` 返回，不会因为中途查看配置而丢失导航上下文；日志详情支持 Summary 和 JSON 两种视图。

### 遇到的问题与修复

- 初次 PTY 验证发现快速发送方向键和回车时，单一 `handlingKey` 标志会丢弃后续按键；改成 FIFO 按键队列；
- 测试请求等待期间如果积压 `t`，测试结束后可能再次触发；改为在 raw-mode 入口和处理器两层丢弃 busy 期间的按键；
- `npm run cli register` 在没有现成登录 session 时最初不会打开注册表单；调整初始化顺序，使 register/login 命令直接进入对应页面；
- Guest 页面和登录页面都支持 `q` 退出，避免用户只能移动到 Exit 再确认。
- 网页端已有删除 deployment 操作，CLI 增加了独立确认表单；最后一个 deployment 不允许删除，避免生成无法通过配置校验的空 route。

### 验证

```text
npm run check 通过
npm run cli -- --help 通过
PTY 验证：上下键高亮、Enter 进入、Esc 返回、API 表单、register 页面通过
npm test：沙箱禁止监听 127.0.0.1，39 个 HTTP 集成用例报 listen EPERM；非网络单元用例通过
```

## 12. DSML tool call 兼容修复（2026-08-23）

### 现象

会话 `01a024cc-d708-7e31-8ea8-c4d754bcf176` 的 rollout 中，助手消息正文包含：

```text
<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="exec">...</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>
```

这说明上游把本应是结构化工具调用的 DSML 协议当成了普通文本返回。Relay 原先会原样转发，Codex 因此直接显示协议标签，而不会执行工具。

### 修复

- 默认开启 `routing.compatibility.convert_dsml_tool_calls`。
- 非流式 Responses 中检测完整 DSML block，将每个 `invoke` 转换为 Responses `function_call` output item。
- 保留 DSML block 外的普通文本，去掉协议标签，避免用户看到内部 XML/DSML。
- 流式响应在检测到完整 DSML block 后转换为 `response.output_item.*`、参数 delta/done 和 `response.completed` 事件。
- 只转换结构完整且包含 `invoke` 的 block；普通文本中的相似片段不会被误删。

### 限制

该兼容层只能恢复上游已经完整返回的工具调用。若上游把工具协议拆成无法闭合的半截文本，Relay 不会伪造调用；这时仍需修正上游的 tool calling 模式或模型适配器。

## 13. 管理页面视图保持与 Logs 自动刷新（2026-08-23）

### 问题

管理页面的 Overview、Logs、APIs 是同一页中的工作区标签。原先刷新配置后没有持久化当前标签，用户在 APIs 页面点击刷新可能回到 Overview；Logs 也只能手动刷新，无法及时看到新调用。

### 设计

- 将当前工作区标签保存到 localStorage，支持 overview、logs、apis 三个值。
- 将 Logs 当前页码和每页条数一起保存，重新加载页面后尽量回到原来的分页位置。
- 管理页内的 Refresh、Save、Reload 等操作完成后重新应用当前标签状态，不改变用户正在查看的工作区。
- Logs 仅在 Logs 标签激活且浏览器页面可见时每 15 秒自动请求当前页；切换到其他标签或页面进入后台后停止轮询。
- 页面重新回到前台时立即刷新一次 Logs，避免后台期间错过最新记录。

### 心得

“刷新数据”和“重置界面导航”应该是两个独立动作。配置刷新只更新数据模型，工作区标签和日志分页属于用户界面状态，应单独持久化并恢复。

## 13. SSE 中途断流导致 Codex 静默停止（2026-08-23）

### 现象

会话 `01a02abe-5bc3-7810-9e8a-249695d5e026` 中多次出现：Codex 已经开始 reasoning 或工具调用，但最终 `task_complete.last_agent_message` 为 `null`，rollout 没有错误，也没有最终输出。

典型证据：

- rollout 行 `7743`：只收到 reasoning item，摘要为 `**Applying patch**`；
- rollout 行 `7745`：`task_complete`，`duration_ms` 约 `120339`，`last_agent_message: null`；
- rollout 行 `7763-7764`：已经执行了一次工具调用；
- rollout 行 `7773`：`task_complete`，`duration_ms` 约 `161058`，`last_agent_message: null`；
- relay state 中对应时间点存在上游失败：`This operation was aborted`，耗时约 `120s`。

这不是 DSML 泄漏问题，而是流式响应中途断开后，Relay 把异常流包装成了看起来正常的完成事件。

### 原因

之前为了避免 Codex 报：

```text
stream disconnected before completion: stream closed before response.completed
```

Relay 在上游 SSE 已经发出首个事件、但后续断流且没有 `response.completed` 时，会合成一个 `response.completed`。这对 `[DONE]` 结尾但缺少 completed 事件的兼容场景有用，但对真实的超时/abort 是错误的。

结果是：Codex 收到了“完成”语义，但没有可见 assistant message，也没有明确 failure，于是表现为任务自己停掉。

### 修复

- 保留 `[DONE]` 兼容：只有检测到 `data: [DONE]` 且缺少 `response.completed` 时，才合成 `response.completed`。
- 对“已提交 SSE 首事件、但未见 `[DONE]`/terminal event 就断流”的情况，改为合成 `response.failed`。
- catch 路径中发生已提交流异常时，也发送 `response.failed`，不再伪造 `response.completed`。
- 记录失败并让 deployment 进入 cooldown，避免同一坏上游持续造成静默停止。

### 回归测试

新增覆盖：

- 已提交首个 SSE event 后断流：应返回 `response.failed`，不 failover，也不返回 `response.completed`；
- 只输出不可见 reasoning 后断流：应返回 `response.failed`，避免 Codex 静默完成；
- 只有 `[DONE]` 的兼容流：仍允许合成 `response.completed`。

验证：

```text
npm test   # 50 passed
npm run check
```

## 14. 两个关键 Bug 的通俗复盘（2026-08-23）

这一轮实际解决的是两个不同层面的兼容问题。它们看起来都发生在 Codex 使用中转站时，但根因不一样。

### Bug 1：`invalid_id_prefix`，历史消息被第三方 ID 污染

#### 现象

Codex 报类似错误：

```text
Invalid 'input[286].id': 'item_200f953b826354e8132eb110'. Expected an ID that begins with 'msg'.
```

或者：

```text
Expected an ID that begins with 'rs'.
```

#### 通俗解释

Responses API 对不同类型的历史 item 有固定 ID 前缀要求：

- 普通消息应该像 `msg_...`；
- reasoning 应该像 `rs_...`；
- function call 应该像 `fc_...`。

但部分第三方上游会返回统一的 `item_...`。Codex 收到后会把这些 item 写进本地 session 历史。下一轮请求或 compact 时，Codex 又把这些历史发回去，于是严格兼容的上游直接拒绝。

所以这个问题不是“当前这一条请求坏了”，而是“上一轮返回的坏 ID 写进了历史，污染了后续请求”。

#### 解决方式

Relay 现在在两端都做了防护：

1. **请求发出前清理历史**：如果 Codex replay 的历史里带了错误 ID，Relay 会在转发上游前去掉这些非法 `id`。
2. **响应返回前清理上游结果**：如果第三方上游返回 `type: "message"` 但 `id` 是 `item_...`，Relay 会先去掉这个错误 ID，再交给 Codex。
3. **reasoning 特殊处理**：非法 reasoning item 不强行改前缀，而是丢弃。因为 reasoning item 可能包含上游私有状态，改个名字并不能保证可用。

#### 结果

坏 ID 不会再进入 Codex 本地历史，也不会在后续 compact/replay 时再次触发 `invalid_id_prefix`。

---

### Bug 2：Codex 自己停了，没有错误、没有输出

#### 现象

会话 `01a02abe-5bc3-7810-9e8a-249695d5e026` 里出现多次：

- Codex 已经开始 reasoning；
- 甚至已经调用过工具；
- 最后却直接 `task_complete`；
- `last_agent_message` 是 `null`；
- UI 上看起来就是“任务自己停了”。

典型 rollout 证据：

```text
7743: reasoning: **Applying patch**
7745: task_complete, last_agent_message: null, duration_ms: 120339
7763-7764: 已经执行 custom_tool_call
7773: task_complete, last_agent_message: null, duration_ms: 161058
```

Relay state 里同一时间也能看到：

```text
This operation was aborted
耗时约 120s
```

#### 通俗解释

之前为了修另一个报错：

```text
stream disconnected before completion: stream closed before response.completed
```

Relay 做过一个兼容逻辑：如果上游流式响应结束时没有 `response.completed`，Relay 就补一个 `response.completed`。

这个逻辑对一种情况是有用的：有些上游最后只发 `data: [DONE]`，不发标准的 `response.completed`。

但它误伤了另一种情况：上游其实是超时或断流了，并不是正常结束。

于是流程变成：

```text
上游真实情况：中途断流 / timeout
Relay 旧行为：补一个 response.completed
Codex 理解：任务正常完成
实际结果：没有最终回答，所以看起来像 Codex 静默停止
```

#### 解决方式

Relay 现在把这两种情况分开处理：

1. **如果看到 `data: [DONE]`**：说明上游至少明确表达了结束，可以继续补 `response.completed`。
2. **如果没有 `[DONE]`，也没有 `response.completed` / `response.failed` / `response.incomplete`**：说明这是异常断流，Relay 不再伪造完成，而是返回 `response.failed`。
3. **已经开始流式输出后断掉**：不会再 failover 到另一个上游，因为客户端已经收到前半段流了；但会明确告诉 Codex 这是失败，而不是完成。
4. **记录失败并 cooldown 当前 deployment**：避免同一个不稳定上游连续造成静默停止。

#### 结果

Codex 不应再把真实断流误判为正常完成。以后如果上游 120s timeout 或 stream abort，应该能看到明确失败，而不是“没有报错也没有输出地停掉”。

---

### 一句话总结

- `invalid_id_prefix` 是 **第三方上游返回了不符合 Responses API 规范的 item ID，污染了 Codex 历史**；解决方式是 Relay 做请求/响应双向清洗。
- 静默停止是 **Relay 把上游异常断流伪装成了正常完成**；解决方式是只在看到 `[DONE]` 时补完成，否则返回 `response.failed`。

这两个问题都属于“中转站协议适配层”的问题，不是普通聊天能力问题。Codex 这种 agent 会持续 replay 历史、调用工具、消费 SSE 事件，所以比普通聊天更容易暴露这些协议语义错误。

## 15. `response.failed` 超时提示与丢弃 item ID 的影响评估（2026-08-23）

### `response.failed` 是否会明确提示超时

当前策略分三类：

1. **明确请求超时**

   如果 Relay 自己的 `request_timeout_ms` 触发，或者流式响应已经开始后，在接近 `request_timeout_ms` 的时间点断开，Relay 会返回：

   ```json
   {
     "type": "response.failed",
     "response": {
       "status": "failed",
       "error": {
         "code": "upstream_timeout",
         "message": "Upstream stream timed out after ...ms before a terminal Responses event."
       }
     }
   }
   ```

   这类会在 `error.code` 上明确标成 `upstream_timeout`。

2. **普通异常断流**

   如果上游很快主动断开，且时间明显没有接近 `request_timeout_ms`，Relay 会返回：

   ```json
   {
     "error": {
       "code": "upstream_network_error",
       "message": "Upstream stream closed before a terminal Responses event."
     }
   }
   ```

   这类不强行说成 timeout，避免误导排查。

3. **兼容 `[DONE]` 的正常结束**

   如果上游最后发了 `data: [DONE]`，只是没发标准 `response.completed`，Relay 仍会补 `response.completed`。这是为了兼容部分 OpenAI-compatible SSE 实现。

### 为什么不用一刀切把所有断流都说成 timeout

因为“断流”有多种原因：

- Relay 自己超时；
- 上游网关超时；
- 上游主动关闭连接；
- 网络层 reset；
- 客户端取消；
- provider 内部崩溃。

只有耗时接近 `request_timeout_ms` 的断流，才有足够证据归为 timeout。否则统一写 timeout 会让后续排查方向变窄，反而误导。

---

### 丢弃/清理 item ID 会不会有副作用

先区分两个动作：

1. **清理非法 `id` 字段**：保留 item 本体，只去掉不合规的 `id`。
2. **丢弃非法 reasoning item**：整个 reasoning item 被移除。

#### 普通 message / function item：只去掉非法 ID，风险低

例如上游返回：

```json
{
  "type": "message",
  "id": "item_xxx",
  "role": "assistant",
  "content": [...]
}
```

Relay 会变成：

```json
{
  "type": "message",
  "role": "assistant",
  "content": [...]
}
```

内容没有丢，`role`、`content`、`call_id` 等关键字段仍保留。副作用主要是：Codex 或上游不能再引用这个错误的 `item_xxx` ID。

但这个 ID 本来就不符合 Responses API 对该类型的前缀要求。保留它的副作用更大：它会污染 session 历史，导致后续 compact/replay 直接失败。

所以对普通 message / function item，**去掉非法 ID 是低风险且必要的防火墙行为**。

#### reasoning item：非法 ID 的 item 被丢弃，风险中等但可接受

reasoning item 比普通消息特殊。它可能代表上游私有的内部推理状态，不只是展示文本。

如果第三方上游返回：

```json
{
  "type": "reasoning",
  "id": "item_xxx",
  "summary": [...],
  "encrypted_content": "..."
}
```

Relay 不会把 `item_xxx` 改成 `rs_xxx`，而是丢弃该 reasoning item。

原因：

- `reasoning.id` 可能和上游内部状态绑定，不是换个前缀就合法；
- `encrypted_content` 往往只对特定 provider 有意义；
- 伪造 `rs_...` 可能让严格上游误以为这是可恢复的官方 reasoning state，后续产生更隐蔽的问题；
- reasoning item 通常不是用户可见内容，丢弃后主要损失的是“跨轮推理状态连续性”，不是业务正文。

#### 可能损失什么

丢弃非法 reasoning item 可能带来这些影响：

- 下一轮模型少了一部分历史 reasoning state；
- 对非常依赖 reasoning carry-over 的长任务，模型可能需要重新理解上下文；
- token 使用可能略有上升，因为模型不能复用那段私有状态；
- 如果某个上游真的依赖自己生成的 `item_xxx` reasoning state，清理后它的连续推理能力可能下降。

#### 避免了什么

清理/丢弃带来的收益更关键：

- 避免 `invalid_id_prefix` 让整条请求失败；
- 避免第三方 provider 的私有状态污染 Codex 本地 session；
- 避免切回官方 OpenAI 或严格兼容上游时 compact 失败；
- 避免把无法验证的第三方 encrypted reasoning 当成可恢复状态继续传递。

#### 最终判断

- **message / function item：去掉非法 ID，副作用很小，收益明确。**
- **reasoning item：丢弃有一定连续性损失，但比伪造 ID 或保留坏 ID 更安全。**
- 当前策略适合 Relay 的定位：它不是盲目透传器，而是 Codex 与多种 OpenAI-compatible 上游之间的协议防火墙。

如果后续确认某个特定上游的 reasoning state 虽然 ID 不规范但确实可用，可以再做 deployment 级开关关闭 `drop_invalid_reasoning_items`。默认开启清理仍然更稳。

## 16. Hard Test：区分普通 API 可用和 Codex-like 流式兼容（2026-08-23）

### 背景

普通 `Test` 请求只验证一件事：这个 deployment 能否完成一个短的非流式 Responses 请求。

它的请求形态接近：

```json
{
  "stream": false,
  "input": "Reply with OK in one short sentence."
}
```

所以它 3-5 秒返回 `OK`，只能证明 API key、base URL、model 名和基础非流式调用可用。

Codex 真实调用更复杂：

- `stream: true`；
- 带工具定义；
- 长 system/developer instructions；
- session 历史 replay；
- reasoning item；
- function call / tool output；
- 必须正确结束 SSE：`response.completed` / `response.failed` / `response.incomplete` / `[DONE]`。

因此会出现“普通 Test 4 秒 OK，但 Codex 调用 120 秒 timeout”的情况。普通 Test 没覆盖 Codex 真正依赖的协议面。

### 实现

管理台每个 API 卡片新增 `Hard Test` 按钮。

Hard Test 会直接对该 deployment 发一个 Codex-like probe：

```json
{
  "stream": true,
  "tools": [
    {
      "type": "function",
      "name": "hard_test_echo"
    }
  ],
  "input": "要求模型尽量调用 hard_test_echo，并正常结束流式响应"
}
```

它会读取完整 SSE 流，并记录 diagnostics：

- `terminal_detected`：是否看到 `response.completed` / `response.failed` / `response.incomplete` / `[DONE]`；
- `failed_event_detected`：是否看到 failed/incomplete；
- `done_marker_detected`：是否看到 `[DONE]`；
- `tool_call_detected`：是否看到结构化工具调用迹象；
- `first_chunk_ms`：首个 SSE chunk 延迟；
- `chunks`：收到的 chunk 数；
- `bytes`：响应体大小；
- `content_type`：上游返回类型；
- `timeout_ms`：本次 hard test 使用的超时时间。

### 判定

Hard Test 的核心判定不是“回答内容像不像 OK”，而是协议是否完成：

1. HTTP 非 2xx：失败，按上游 HTTP 错误分类。
2. SSE 没有 terminal event，也没有 `[DONE]`：失败，通常是 Codex 静默停止或 120s timeout 的高风险信号。
3. SSE 返回 `response.failed` / `response.incomplete`：失败，说明上游明确没有完成。
4. SSE 正常完成但没有检测到工具调用：通过，但带 warning：`streaming completed, but tool-calling compatibility is not proven`。
5. SSE 正常完成且检测到工具调用：通过，说明该 deployment 更接近 Codex 所需能力。

### 为什么工具调用不作为硬失败

并不是所有模型都会在 probe 中选择调用工具；有些兼容层也可能把工具调用转换成文本。为了避免误杀，Hard Test 把“没有工具调用”记为 warning，而不是失败。

真正必须失败的是：流式请求不能正常结束，或者上游明确 failed/incomplete。因为这正是 Codex 任务静默停止和 120 秒超时的主要风险。

### 使用方式

在网页管理台：

```text
APIs → 目标 deployment → Hard Test
```

结果弹窗里看 `diagnostics`：

- `terminal_detected: false`：优先怀疑上游 SSE 不完整或流式超时；
- `tool_call_detected: false`：普通流式可用，但工具调用兼容性没有被证明；
- `first_chunk_ms` 很高：上游首包慢；
- `chunks` 很少且最后 timeout：上游可能发了开头就卡住；
- `content_type` 不是 `text/event-stream`：上游可能没有真正按 SSE 返回。

### 验证

新增回归测试：

- Hard Test 会发送 `stream: true` 和 `tools`；
- Hard Test 能识别 terminal event 和工具调用；
- Hard Test 对永不结束的 SSE probe 返回 `upstream_timeout`。

## 17. DeepSeek thinking 模式 `reasoning_text` 报错处理（2026-08-23）

### 现象

使用 DeepSeek deployment 时出现：

```text
The `reasoning_text` in the thinking mode must be passed back to the API.
```

本地日志中能看到 DeepSeek 的上一轮 Responses payload 会返回类似结构：

```json
{
  "type": "reasoning",
  "id": "非 rs_ 前缀的 provider 私有 ID",
  "content": [
    { "type": "reasoning_text", "text": "..." }
  ],
  "encrypted_content": "..."
}
```

而 Relay 的默认防污染策略会丢弃非法 reasoning item，避免 `item_*`、UUID 等第三方私有 reasoning state 污染 Codex 历史。这个策略对 Modelgate/OpenAI-like 严格兼容路径是正确的，但会和 DeepSeek 的 thinking state 续写要求冲突。

### 是否针对 Modelgate 硬编码

没有针对 Modelgate 硬编码。当前兼容逻辑是通用的 Responses 协议防火墙：

- 清理非法 item id；
- 丢弃非法 reasoning item；
- DSML tool call 转 function_call；
- SSE 断流转 response.failed。

真正的问题是：不同上游对 reasoning state 的要求不同。DeepSeek 在 thinking 模式下可能要求上一轮 `reasoning_text` 被带回；而 Relay 为了避免污染 Codex 历史，默认不保留第三方非法 reasoning item。

### 修复

新增 deployment 级兼容开关：

```json
{
  "compatibility": {
    "strip_previous_response_id": true
  }
}
```

含义：转发给该上游前删除 `previous_response_id`。

这样 DeepSeek 不会继续绑定上一轮服务端 response state，也就不会要求 Relay 回传被清理掉的 `reasoning_text`。Codex 仍然会通过 `input` 历史携带可见上下文，只是不再依赖 DeepSeek 的 provider-side previous response continuation。

已给 `deepseek-v1` deployment 启用该开关。

### 取舍

收益：

- 避免 DeepSeek 因 missing `reasoning_text` 直接 400；
- 保持 Relay 对非法 reasoning item 的默认防污染策略；
- 不影响 Modelgate/OpenAI-like provider，它们仍可使用 `previous_response_id`。

代价：

- DeepSeek 上不能利用 provider-side previous response state；
- 长上下文任务更多依赖 Codex replay 的显式历史；
- 如果后续要完整支持 DeepSeek thinking state，需要单独实现 DeepSeek reasoning item 的安全保留/回传，而不能简单把第三方 reasoning item 透传给所有 provider。

### 验证

新增回归测试：

- 显式配置 `strip_previous_response_id: true` 的 deployment 会删除 `previous_response_id`；
- 未配置的普通 provider 不受影响，仍保留 `previous_response_id`。

## 18. `X-OpenAI-Internal-Codex-Responses-Lite` 与 provider/model 混用（2026-08-23）

### 现象

会话 `01a024cc-d708-7e31-8ea8-c4d754bcf176` 在 rollout 行 `19520` 报错：

```json
{
  "type": "invalid_request_error",
  "code": "unsupported_value",
  "message": "This model is not supported when using X-OpenAI-Internal-Codex-Responses-Lite.",
  "param": "model"
}
```

同一 turn 的设置显示：

```text
model_provider_id: openai
model: gpt-5.5
comp_hash: relay
```

本地 `~/.codex/state_5.sqlite` 中该 thread 也确认是：

```text
id = 01a024cc-d708-7e31-8ea8-c4d754bcf176
model_provider = openai
model = gpt-5.5
```

### 通俗解释

`X-OpenAI-Internal-Codex-Responses-Lite` 是 Codex 客户端内部使用的 Responses Lite 路径 header。这个路径只支持一组特定的官方模型。

但 `gpt-5.5` 在当前环境里是 Relay/Modelgate 侧使用的模型名，不是官方 OpenAI provider 在 Codex Lite 路径下可接受的模型。

因此错误的实际含义是：

> 这个 thread 仍然走 `openai` provider，却使用了 relay/modelgate 的 `gpt-5.5` 模型名；官方 OpenAI 的 Codex Lite 路径拒绝了这个组合。

这不是上游 Modelgate 的错误，也不是 Relay 返回的错误；它发生在 Codex 直接走官方 `openai` provider 的路径上。

### 修复

已将该 thread 在 Codex 本地状态中的 provider 改回 relay：

```sql
UPDATE threads
SET model_provider = 'relay'
WHERE id = '01a024cc-d708-7e31-8ea8-c4d754bcf176';
```

修复前：

```text
('01a024cc-d708-7e31-8ea8-c4d754bcf176', 'openai', 'gpt-5.5')
```

修复后：

```text
('01a024cc-d708-7e31-8ea8-c4d754bcf176', 'relay', 'gpt-5.5')
```

### 后续注意

如果以后再次看到这个错误，优先检查两处：

```bash
grep -n "model_provider\|model =" ~/.codex/config.toml
sqlite3 ~/.codex/state_5.sqlite \
  "select id, model_provider, model from threads where id='<thread_id>';"
```

只要是 `model_provider=openai` 搭配 relay-only 的模型名，例如 `gpt-5.5`，就会有类似风险。

## 14. 调用详情 token 估算与 Summary 视图优化（2026-08-23）

### 现象与原因

某条调用详情显示 output tokens 为 2048，同时 total tokens 带有 EST 标记。这个数字不是上游真实 usage：当上游没有返回 usage 时，旧逻辑从流式响应最后保留的约 8192 个字符 streamTail 估算输出，按约 4 字符/token 计算后正好得到 8192 / 4 = 2048。

streamTail 是为了诊断和终端事件判断保留的尾部缓存，不代表完整模型输出；尤其当上游响应混入很长的工具协议或上下文时，用它估算 token 会明显误导。

### 修复

- 新增流式 response.output_text.delta 提取器，按真实文本 delta 累积输出文本。
- 流式 usage 缺失时优先使用完整文本 delta 估算，不再把固定长度的 SSE 尾部当作输出。
- 兼容只返回 `response.output_item.done` 或 `response.completed.output` 的 provider；这类完整 message 文本单独累计，避免和 delta 重复计算。
- 只有文本 delta、完整 message item 都无法提取时，才回退到原有 SSE 尾部逻辑，并继续标记为估算。
- Summary 中 input/output/total token 均明确使用约等于符号和 EST 标记，并显示 estimated_reason，不再把估算数字表现为精确账单数据。
- Summary 改为调用详情面板：顶部展示调用状态、deployment -> model 路径和耗时，中部使用三段 token strip，底部区分 Response Preview、Request Context、错误和诊断信息；JSON 视图保持可用。
- Response Preview 仅在展示层把上游返回的字面量 `\\n`、`\\t` 转成可读换行和制表符；JSON 视图保留原始值，便于排查上游协议问题。

### 验证

新增回归测试使用 9000 字符的 SSE text delta，以及没有 delta、只有完整 message item 的两种流，均确认估算 output 为 2250，而不是由尾部缓存固定得到的 2048。

## 15. Logs 路径、原始响应和分页修复（2026-08-23）

### 需求

本轮需要同时解决三个使用问题：

- Overview、Logs 和 API 页面中的大数字需要使用千位分隔符；
- Logs 需要显示 Codex rollout 文件路径，并允许查看上游完整原始响应；
- 日志列表分页在自动刷新、快速点击和刷新配置后不能跳回旧页或被旧请求覆盖。

### 设计

1. 日志列表继续只返回状态、模型、耗时、token 摘要和文件引用，不把完整上游响应塞入 /admin/calls，避免列表响应和浏览器 DOM 随响应体增长。
2. 每次成功或失败的上游响应在转发结束后写入本地受保护目录，文件使用 0600，目录使用 0700。文件保存原始响应文本、content type 和是否流式，不保存 API key。
3. 新增 GET /admin/calls/:raw_id/raw。只有点击详情的 JSON 页签时，前端才请求这个接口；流式响应按原始 SSE 文本展示，普通 JSON 先解析后格式化展示。
4. 请求会从 body、常见 Codex thread header 和 JSON metadata header 中提取 thread ID，再通过 ~/.codex/state_5.sqlite 查询 threads.rollout_path。未识别到 thread ID 时明确显示 rollout · not identified，不根据“最近会话”猜路径。
5. /admin/calls 现在返回 page 和 total_pages。状态层会把超出范围的 offset 规整到最后一页；前端使用请求序列号和 loading 状态，自动刷新返回旧数据时不会覆盖用户刚切换的页。

### 遇到的问题和处理

- 原来详情 JSON 只是 runtime call 对象，不是上游原始 JSON。现在列表与原始响应解耦，旧日志仍能查看 metadata，新日志才提供完整 raw response。
- 流式转发过程中只保留了用于诊断的 streamTail，不能拿它代表完整响应。新增独立的原始流缓冲，只在落盘阶段使用，不参与 token 估算和列表渲染。
- 前端分页原先根据本地 logPage 和旧数组自行推导状态；自动刷新或多个请求同时返回时会出现页面错位。现在以后端返回的 page/total_pages 为准，并丢弃过期请求。
- rollout 路径不是每个 Responses 请求都带有公开的 thread ID。错误猜测比显示未识别更危险，因此只接受明确可关联的 ID。

### 验证

- npm run check 通过。
- npm test 通过，包含 raw response 按需读取和 thread header 记录测试。
- 新增测试确认完整的上游字段不出现在 /admin/calls 列表，只能通过 raw 接口按需读取。

## 19. 最近活跃 Session 与 RPM 看板（2026-08-23）

### 需求

本轮增加一个 Sessions 工作区，用于查看最近活跃的 Codex session、该 session 关联的 Relay 请求、RPM、token 汇总和最近请求详情。页面需要支持多个关键词搜索、默认最近排序、分页和自动刷新。

### 设计

1. Session 元数据来自 `~/.codex/state_5.sqlite` 的 `threads` 表，包含 `id`、标题、预览、工作目录、模型、provider、reasoning effort 和 rollout 路径。
2. Relay 请求来自当前 profile 的持久化 `recent_calls`，只按明确写入的 `thread_id` 关联。没有 thread ID 的调用计入 `unlinked_calls`，不会根据最近时间或最近 thread 猜测归属。
3. 新增 `GET /admin/sessions`，支持 `q`、`sort`、`window`、`offset` 和 `limit`。列表只返回 session 摘要和最近 8 条调用摘要；点击 session 后可以查看最近请求，再复用已有 Call Detail 的 Summary/JSON 详情。
4. 搜索词按空白切分，所有词都必须命中同一个 session 的可搜索字段。字段包括 session ID、标题、预览、首条用户消息、目录、provider、模型、reasoning、rollout 路径，以及最近请求的 request ID、deployment 和模型信息。

### RPM 口径

主指标使用固定时间窗口：

```text
RPM = requests_in_last_window / window_minutes
```

默认窗口为 15 分钟，也可切换 5 分钟和 60 分钟。固定窗口的优点是跨 session 可比较，并且单次请求只会显示 `1 / 15 = 0.07 RPM`，不会把一次请求夸大成无限高的速率。

详情中另显示 `observed RPM`，用于描述已记录请求之间的密度：请求数为 1 时显示 0；请求数大于 1 时，使用首尾请求时间跨度，并将最小观测区间限制为 1 分钟。它适合观察短时间 burst，但不作为主比较指标。

### 遇到的问题和处理

- SQLite 不存在、没有 `sqlite3` 命令或 `threads` 表不可读时，接口仍返回由明确 `thread_id` 产生的 Relay-linked sessions，并在界面提示元数据不可用。
- 初版合并调用时把 fallback 的 `Relay-linked session` 标题覆盖了 SQLite 中真实的 session 标题。修复为只有在 session 没有标题时才使用 fallback，避免搜索和展示丢失 Codex 元数据。
- 自动刷新期间用户可能正在输入搜索词。现在刷新不会覆盖当前聚焦的输入框；搜索、排序和窗口变化仍然显式触发新的查询。
- Sessions 请求增加请求序列保护，旧的自动刷新响应不能覆盖新搜索或新分页结果。当前页、搜索词、排序和窗口会保存在浏览器本地状态中。

### 验证

- 新增集成测试验证 SQLite threads 与 Relay calls 的合并、rollout 路径、多个关键词 AND 搜索、未关联调用计数、固定窗口 RPM 和分页字段。
- `npm test` 通过，共 59 个测试。
- `npm run check` 通过。
- 管理台生成后的 inline script 通过 `new Function` 语法检查。

## 20. 网页端停止 Relay 服务与后台启动脚本（2026-08-23）

### 需求

用户希望不再回到终端执行停止操作，而是在网页管理台中直接关闭本地中转站。

### 设计

- 新增受保护的 `POST /admin/shutdown`。
- 只允许通过 `adminContext` 鉴权的请求；本机管理员、远程管理员和登录账号都可以执行，未登录请求仍返回 401。
- 返回 `202 shutting_down` 后，服务使用 `server.close()` 停止接收新连接，并关闭空闲连接；当前请求完成后释放监听端口。
- 管理台在认证成功后显示 `Stop Relay`，点击后需要浏览器二次确认，成功后禁用控件并提示使用 `npm run start:background` 恢复服务。
- 新增 `scripts/start-relay.sh` 和 `npm run start:background`，支持 PID 文件、日志文件、重复启动保护和端口冲突失败提示。
- 后续脚本验证发现自定义端口仍打印固定的 `8787`，已改为从启动日志读取真实监听地址；PID 文件命中时也会核对进程命令行，降低 PID 复用造成误判的风险。

### 遇到的问题和处理

之前直接执行 `kill -TERM <node-pid>` 时，macOS `launchd` 的 `keepalive` 会自动重新拉起 Relay。网页按钮只负责停止当前 HTTP 服务；如果用户另外配置了 launchd、Docker 或其他进程管理器，管理器仍可能按照自己的策略重启它。后台脚本同样不接管外部进程管理器，只负责启动一个独立 Node 进程。

初版页面用 `profile.kind` 判断是否显示停止按钮，导致 Guest 管理员（包括远程管理员）在刷新配置后被误判为不可关闭。修复为在管理鉴权成功的响应中返回独立的 `can_shutdown` 能力字段；身份是 Guest 还是 account 不再决定是否有关闭权限。

### 验证

- 未授权请求返回 401。
- 管理员和账号请求返回 202，随后 HTTP server 不再监听端口。
- `npm run check`、`npm test` 和管理台 inline script 检查通过。

## 21. Logs 翻页递归与 Sessions 空列表修复（2026-08-23）

### 现象

- Logs 接口已经返回多页，但网页端点击 `Next`、`Prev` 后没有正常切换。
- Sessions 页面显示空列表，统计值保持为 0。

### 定位

通过浏览器实际点击 Sessions 后读取控制台错误，确认错误为：

```text
RangeError: Maximum call stack size exceeded
at window.loadSessions (...)
```

页面底部把内部函数再次暴露为同名的 `window.loadSessions`：

```js
window.loadSessions = (page) => loadSessions(page).catch(...)
```

浏览器解析后，包装函数中的 `loadSessions` 也指向了 `window.loadSessions`，形成无限递归。Logs 使用了同样的命名模式，因此分页按钮虽然可见，但点击后请求没有完成。

### 实现

1. 将内部请求函数改为 `requestLogPage` 和 `requestSessions`，保留 `window.loadLogPage`、`window.loadSessions` 作为稳定的 HTML 事件入口，避免名称覆盖。
2. Logs 增加 `logPageLoaded` 状态。服务端返回合法空页时，页面保持空页，不再因为 `logCalls.length === 0` 回退显示旧的 `runtimeStatus.recent_calls`。
3. Sessions 读取 `threads.tokens_used`。即使 Relay 调用没有明确的 `thread_id`，只要 Codex SQLite 中保存了该 session 的 token 使用量，页面仍会显示它。
4. Sessions 返回 `codex_total_tokens`、`relay_total_tokens` 和 `token_source`。来源可显示为 `codex_sqlite`、`relay_usage` 或 `both`，避免用户误把两个来源混为一次调用。
5. Session 卡片增加 token 来源提示，便于区分 Codex 持久化统计和 Relay 当前 profile 的调用统计。

### 验证

- 浏览器验证 Sessions 能显示真实 Codex session、模型、rollout 路径及 token 来源。
- 浏览器验证 Logs 从 `Page 1/25 · 1-20 of 500` 切换到 `Page 2/25 · 21-40 of 500`，列表内容随页面改变。
- `npm test` 通过，共 62 个测试；新增测试覆盖“无 Relay 关联调用但有 SQLite token 使用量”的 session。
- `npm run check` 通过。
- `git diff --check` 通过。
