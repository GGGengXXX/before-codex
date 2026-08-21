# Codex Relay 实现过程记录

最后更新：2026-08-21

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
npm test       30 个测试通过
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
      "strip_invalid_request_item_ids": true
    }
  }
}
```

也可以在单个 deployment 上覆盖 `compatibility`。

### 行为

- 请求侧：当 Codex replay 的 `input` 数组中出现 `type: "reasoning"` 但 ID 不是 `rs*` 时，转发上游前移除该 item。
- 请求侧：普通 `message`、`function_call`、`function_call_output` 如果带有明显错误的第三方 `id`，会去掉 `id`，但保留内容和 `call_id`。
- 响应侧：非流式 JSON 响应中的非法 reasoning item 会被移除，避免再次写入 Codex 本地历史。
- 响应侧：SSE 中的非法 reasoning item 事件会被丢弃，`response.completed` 里的 `output` 数组也会同步清理。

### 心得

这类兼容层最容易犯的错是“修前缀”。但 Responses item ID 不是纯展示字段，它可能参与后续状态恢复。中转站更适合做协议防火墙：丢弃明确非法、不可移植的 provider state，保留用户消息、工具输出和可读文本。

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
