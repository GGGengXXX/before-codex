# Codex 中转站开源实现调研

调研时间：2026-08-20

## 1. 调研目标

本项目希望为 Codex 提供一个稳定的 OpenAI-compatible 中转入口，并支持：

- 多个上游 URL；
- 同一上游的多个 API Key；
- Key 余额不足、计费失败、权限失效或限流时自动切换；
- 不同上游之间的优先级、权重和故障转移；
- OpenAI Responses API；
- SSE 流式响应、工具调用和 Codex 多轮会话；
- 不向 Codex 暴露真实上游密钥。

本次优先查看官方 GitHub 仓库、官方 README、官方文档、许可证文件和源码入口。项目是否“支持”某项能力，只有在官方资料明确说明或源码中能够直接确认时才标记为支持；没有确认的能力标为“未确认”，不将普通 Chat Completions 兼容误判为 Codex 兼容。

## 2. 结论摘要

目前没有发现一个可以无条件直接替代本项目、同时完美覆盖“多 URL、多 Key、余额故障转移、Responses API、Codex 会话连续性”的轻量实现。

最值得组合借鉴的实现是：

1. **Bifrost**：最贴近多 API Key 的错误分类、Key rotation 和 Provider fallback。
2. **LiteLLM**：多 deployment 路由、冷却、Fallback，以及 Responses API 的会话亲和性处理最值得参考。
3. **Portkey Gateway**：路由配置树、权重、Fallback、条件路由、重试和熔断器模型清晰。
4. **Floway**：当前公开项目中，对 coding agent、Codex 配置生成、Stateful Responses 和控制面/数据面分离的方向非常贴近本项目。
5. **New API / One API**：适合参考渠道、额度、模型映射、运营后台和统计，但不建议直接把它们的传统 OpenAI 兼容能力等同于 Codex 兼容。
6. **Gozar**：适合参考私有部署、密钥加密、Fallback chain、上游账号和管理 API，但许可证和项目成熟度需要单独评估。
7. **Helicone**：适合参考观测、成本、延迟、日志和 Provider 评分，不适合作为余额级 Key 熔断的唯一依据。
8. **Envoy AI Gateway / SMG / TensorZero**：适合参考生产级路由、可靠性、可观测性和云原生部署，但对本项目的轻量 MVP 偏重，且部分 Codex 语义未确认。

本项目建议采用：

> **Bifrost 的错误分类与 Key rotation + LiteLLM 的 Responses affinity + Portkey 的路由配置模型 + Floway 的 coding-agent/Stateful Responses 方向。**

## 3. 能力对比

| 项目 | 仓库 | 许可证 | 多 URL / 多 Provider | 同一 Provider 多 Key | 失败转移 / 冷却 | Responses API / SSE | Codex 相关性 |
|---|---|---|---|---|---|---|---|
| LiteLLM | [BerriAI/litellm](https://github.com/BerriAI/litellm) | MIT；`enterprise/` 有独立许可 | 支持，多 deployment | 支持，以独立 deployment 配置 | 支持权重、优先级、Fallback、cooldown、Redis 状态 | 官方文档明确有 `/v1/responses` 和流式能力 | 高，重点是会话连续性与加密 reasoning affinity |
| Bifrost | [maximhq/bifrost](https://github.com/maximhq/bifrost) | Apache-2.0 | 支持 Provider fallback | 明确支持 `keys[]` 和权重 | 明确区分 401/402/403/429、5xx、网络错误 | 官方文档明确支持 Responses SSE | 很高，官方文档提供 Codex CLI 配置方向 |
| Portkey Gateway | [Portkey-AI/gateway](https://github.com/Portkey-AI/gateway) | MIT | 支持 | 支持多个 Provider/API Key | 支持 single/loadbalance/fallback/conditional、retry、circuit breaker | 官方文档明确有 Responses API | 高，协议层和路由策略值得借鉴 |
| Floway | [Menci/Floway](https://github.com/Menci/Floway) | MIT | 支持 upstreams 和自定义 HTTP Provider | 支持 API Key 管理；具体余额级轮换需继续核验 | 支持 routing order、fallback 和 telemetry | README 明确支持 Stateful Responses、SSE、`previous_response_id` | 很高，面向 coding agents，支持生成 Codex 配置 |
| New API | [QuantumNous/new-api](https://github.com/QuantumNous/new-api) | AGPL-3.0，并有项目附加条款 | 支持渠道 | 通过渠道管理 | 渠道加权随机、失败重试、额度查询 | README 明确列出 Responses；格式转换仍标注开发中 | 中高，功能广但协议转换风险较高 |
| One API | [songquanpeng/one-api](https://github.com/songquanpeng/one-api) | MIT | 支持渠道和镜像 | 通过渠道管理 | 多渠道负载均衡、失败重试、余额更新 | 原始 README 未确认完整 Responses | 中，适合参考渠道与后台模型 |
| Gozar | [sina2266/Gozar](https://github.com/sina2266/Gozar) | PolyForm Noncommercial 1.0.0 | 支持 Provider 和 fallback chain | 支持上游账号/Key；余额级策略需继续核验 | 支持链式 fallback、健康检查、可选错误策略 | README 主要明确 Chat/Embeddings；完整 Responses 需继续核验 | 中高，面向私有项目、Agent 和 Codex 账号 |
| Helicone | [Helicone/helicone](https://github.com/Helicone/helicone) | Apache-2.0 | 支持多 Provider | BYOK；逐 Key 轮换语义未确认 | Intelligent Routing、Automatic Fallback | 官方 Gateway 资料本轮未确认完整 Responses | 中，适合观测和成本模块 |
| Envoy AI Gateway | [envoyproxy/ai-gateway](https://github.com/envoyproxy/ai-gateway) | Apache-2.0 | 支持云原生 Backend/Route | 上游认证支持；余额级多 Key 未确认 | Failover、策略和限流能力强 | 本轮未确认完整 Codex Responses 语义 | 中，适合未来 Kubernetes 化 |
| SMG | [smg-project/smg](https://github.com/smg-project/smg) | Apache-2.0 | 支持云 Provider 和 OpenAI-compatible backend | API Key 认证支持；余额级轮换未确认 | Circuit breaker、retry、限流和多种 routing policy | README 明确列出 Responses 和 Conversations API | 中高，协议覆盖广，但定位偏大规模基础设施 |
| TensorZero | [tensorzero/tensorzero](https://github.com/tensorzero/tensorzero) | Apache-2.0 | 支持多 Provider 和 OpenAI-compatible API | 未确认明确的多 Key 轮换语义 | retries、fallbacks、load balancing | 本轮未确认完整 `/v1/responses` 兼容 | 中，适合参考路由和观测架构 |

## 4. 重点项目分析

### 4.1 LiteLLM：Responses 会话连续性的主要参考

LiteLLM 将同一个逻辑模型拆成多个 deployment。每个 deployment 可以拥有自己的模型、`api_key`、`api_base` 和路由元数据。Router 负责：

- 多 deployment 负载均衡；
- 权重与优先级；
- retries；
- cooldown；
- Provider fallback；
- 生产环境通过 Redis 共享 cooldown 和使用状态。

官方文档对 Responses API 的说明尤其重要。Responses 请求不能简单视为无状态 HTTP 转发，因为：

- `previous_response_id` 可能要求后续请求回到原 deployment；
- reasoning item 可能含有只有原 Provider 或原 Key 能解密/继续使用的内容；
- 切换 Key 或 endpoint 后，可能出现 `invalid_encrypted_content`；
- 流式 Responses 使用事件式 SSE，不能只把 Chat Completions 的 `data: [DONE]` 逻辑套过来。

**适合借鉴的模块：**

- `model_alias -> deployment_pool`；
- deployment 健康状态；
- per-deployment cooldown；
- `response_id -> deployment/key/endpoint` 绑定；
- Provider adapter 和 Router 分离；
- 流式与非流式使用同一套路由上下文。

**需要注意：**

- LiteLLM 仓库主体是 MIT，但官方 LICENSE 明确指出 `enterprise/` 目录如果存在则使用独立许可证；
- LiteLLM 功能面很大，直接整体引入会带来较高复杂度；
- 本项目若只需要 Codex 的 Responses 中转，应该提取设计，不应默认复制完整网关。

来源：

- [LiteLLM GitHub](https://github.com/BerriAI/litellm)
- [Router - Load Balancing](https://docs.litellm.ai/docs/routing)
- [Responses API](https://docs.litellm.ai/docs/response_api)
- [LiteLLM LICENSE](https://raw.githubusercontent.com/BerriAI/litellm/main/LICENSE)

### 4.2 Bifrost：多 Key 余额/权限失败转移的最佳参考

Bifrost 的官方文档将失败分成两类：

1. **Per-key failure**：问题在凭证或账户，例如 401、402、403、429；
2. **Transient server failure**：问题在上游服务，例如 5xx、DNS、连接失败。

其路由行为是：

- 401/403：当前请求中将 Key 视为永久失效，立即切换；
- 402：视为计费/余额失败，当前请求中将 Key 视为永久失效，立即切换；
- 429：切换到其他 Key，但保留退避，因为多个 Key 可能共享账户级限额；
- 5xx/网络错误：继续使用同一个 Key，以指数退避重试；
- 当前 Provider 的重试预算耗尽后，再进入 Provider fallback；
- 每个 fallback Provider 拥有自己的重试预算。

Bifrost 还明确支持：

- Provider 内的 `keys[]`；
- Key 权重；
- `network_config.max_retries`；
- 初始和最大退避时间；
- `/v1/responses`；
- 事件式 Responses SSE；
- Codex CLI 的 Gateway 配置方向。

**适合借鉴的模块：**

- `classify(error) -> key_failure | transient_failure | request_error`；
- 请求级 `used_keys` 集合；
- 永久失效 Key 与可重试 Key 的区别；
- Provider retry budget 与 global fallback budget 分离；
- `upstream_credentials_exhausted` 这类对调用方更有解释力的错误；
- 对 Key ID 做脱敏审计；
- `attempt_trail`，记录每次尝试的 Provider、Key、状态码和耗时。

**对本项目的直接启发：**

不要把“收到任意 4xx 就切 Key”作为规则。400、404、422 往往是请求模型、参数或能力不匹配，切换 Key 只会掩盖真正错误。402/余额错误才应该进入 Key 级熔断；429 则需要依据 Provider 行为选择 Key rotation 和退避。

来源：

- [Bifrost GitHub](https://github.com/maximhq/bifrost)
- [Retries & Fallbacks](https://docs.getbifrost.ai/features/retries-and-fallbacks)
- [Streaming](https://docs.getbifrost.ai/quickstart/gateway/streaming)
- [Bifrost LICENSE](https://raw.githubusercontent.com/maximhq/bifrost/main/LICENSE)

### 4.3 Portkey Gateway：路由配置和熔断器的参考

Portkey 将路由策略抽象成配置对象，支持：

- `single`；
- `loadbalance`；
- `fallback`；
- `conditional`。

目标可以设置：

- Provider；
- API Key；
- 权重；
- retries；
- 触发 fallback 的状态码；
- `Retry-After`；
- circuit breaker 的失败阈值和冷却间隔。

这种模型支持嵌套路由，例如：

```text
loadbalance(keys) -> fallback(provider-b) -> fallback(provider-c)
```

这比在代码中写死“先尝试 A，失败后尝试 B”更适合未来扩展，也能让一个模型同时拥有不同的路由策略。

Portkey 官方资料还明确提供 Responses API，并通过统一的 Responses 事件格式对不同 Provider 做适配。

**适合借鉴的模块：**

- JSON 路由配置树；
- Provider slug；
- target-level retry；
- 按状态码触发 fallback；
- circuit breaker；
- 路由链追踪；
- 把可靠性策略和 Provider 协议适配拆开。

**需要注意：**

- Portkey Gateway README 当前提示 Gateway 2.0 为预发布方向；
- 使用时应固定 release/tag，而不是直接跟踪动态分支；
- Portkey 的企业/托管能力不能默认视为开源仓库能力。

来源：

- [Portkey Gateway GitHub](https://github.com/Portkey-AI/gateway)
- [Gateway Config Object](https://docs.portkey.ai/docs/api-reference/inference-api/config-object)
- [Open Responses](https://docs.portkey.ai/docs/product/ai-gateway/responses-api)
- [Portkey LICENSE](https://raw.githubusercontent.com/Portkey-AI/gateway/main/LICENSE)

### 4.4 Floway：最贴近 Coding Agent 的新项目

Floway 的定位不是泛用 LLMOps，而是将订阅型 Provider、Token 型 Provider、OpenAI-compatible HTTP Provider 放在一个 Gateway 后，服务 Coding Agent 和 API Client。

README 明确列出：

- OpenAI Completions；
- OpenAI Chat Completions；
- OpenAI Responses；
- `/v1/responses/compact`；
- Responses WebSocket；
- `previous_response_id` 相关的 Stateful Responses 数据持久化；
- 上游、路由顺序、模型别名、API Key 和 telemetry 的控制面；
- 一键生成 Claude Code 和 Codex 配置；
- Cloudflare Workers、Node.js、Docker Compose 部署。

**适合借鉴的模块：**

- “控制面 + 数据面”分离；
- coding-agent 特定的模型发现；
- upstream/provider/account/model 分层；
- Stateful Responses 数据落盘；
- Codex 配置生成器；
- 自定义 HTTP upstream；
- 统一的模型目录和别名。

**尚需继续核验的地方：**

- 同一 Provider 多 API Key 的余额级 rotation 是否已经实现；
- 多 Key 是否按请求级、Provider 级或账户级冷却；
- Responses 上游转换对 reasoning、tool call 和 encrypted content 的覆盖范围；
- 当前项目的 release 稳定性和生产使用经验。

来源：

- [Floway GitHub](https://github.com/Menci/Floway)
- [Floway LICENSE](https://raw.githubusercontent.com/Menci/Floway/main/LICENSE)

### 4.5 New API 与 One API：渠道、额度和后台模型的参考

One API 的 README 明确支持：

- 多模型；
- 多渠道；
- 多渠道负载均衡；
- stream；
- 失败自动重试；
- 渠道余额定期更新；
- 渠道健康检查；
- 模型映射；
- Token、用户组和额度管理。

New API 在此基础上扩展了：

- OpenAI Responses；
- OpenAI Realtime；
- 渠道加权随机；
- 失败自动重试；
- Key quota 查询；
- Responses 与 Chat Completions 的转换入口；
- 中文后台和运营能力。

这类项目非常适合参考数据模型：

```text
user
token
group
provider/channel
model
model_mapping
quota
balance
priority
weight
health
```

但它们的主要历史重心是 OpenAI Chat Completions 聚合。New API 的 README 仍将 “OpenAI Compatible <-> OpenAI Responses” 标记为开发中，因此不能仅凭存在 `/v1/responses` 路由就判断对 Codex 完全兼容。

**适合借鉴的模块：**

- 渠道管理；
- 模型权限；
- 用户/Token 管理；
- 额度和计费统计；
- 后台管理 API；
- 模型映射；
- 渠道健康状态。

**不建议直接照搬的部分：**

- 将不同协议简单转换成 Chat Completions；
- 用普通余额定时查询替代请求级错误分类；
- 在 Responses 请求中随意重构 body；
- 将 AGPL 代码直接嵌入本项目而不评估分发义务。

许可证：

- [One API LICENSE](https://raw.githubusercontent.com/songquanpeng/one-api/main/LICENSE)
- [New API LICENSE](https://raw.githubusercontent.com/QuantumNous/new-api/main/LICENSE)

来源：

- [One API GitHub](https://github.com/songquanpeng/one-api)
- [New API GitHub](https://github.com/QuantumNous/new-api)
- [New API Responses 文档](https://docs.newapi.pro/en/docs/api/ai-model/chat/openai/create-response)

### 4.6 Gozar：私有部署和 Fallback Chain 的参考

Gozar 面向私有项目、团队和开发者工作流，强调：

- 一个稳定的 `/v1` 数据面；
- 一个独立的 `/api` 控制面；
- operator-managed upstream accounts；
- Provider-aware fallback chains；
- API Key 加密保存；
- 健康检查；
- trace 和 analytics；
- OpenAI-compatible client；
- Codex subscription account。

它的链式模型可以抽象为：

```text
client key -> chain -> lane -> account -> provider/model
```

这对本项目的配置设计有启发：调用方只需要一个中转 Key，真实上游 Key 和账号应在服务端保存；一条链可以根据 endpoint 或模型类型进入不同 lane。

Gozar 当前 README 标记为 `0.1.0`，并使用 PolyForm Noncommercial 1.0.0。若本项目计划公开发布、商业部署或对外提供服务，必须先评估该许可证是否适用。

来源：

- [Gozar GitHub](https://github.com/sina2266/Gozar)
- [Gozar LICENSE](https://raw.githubusercontent.com/sina2266/Gozar/main/LICENSE)

### 4.7 Helicone：观测和成本层的参考

Helicone 的公开项目将 AI Gateway 与 LLM Observability 结合，README 明确提到：

- 统一 OpenAI API；
- 100+ Provider；
- intelligent routing；
- automatic fallback；
- BYOK；
- cost、token、latency 和 quality 统计；
- 日志、trace、session 和 ClickHouse 分析。

本轮官方资料没有确认以下细节：

- 同一 Provider 多 API Key 的轮换规则；
- 402 是否会单独熔断某个 Key；
- 429 是按 Key、账户还是 Provider 冷却；
- `/v1/responses` 是否完整覆盖 Codex 所需事件和状态。

因此 Helicone 更适合作为本项目的观测设计参考，而不是直接承担核心 Key failover：

- 请求级 trace；
- Provider/Key 维度延迟；
- token 和成本；
- 错误率；
- 路由命中率；
- fallback 次数；
- 可审计的 request ID。

来源：

- [Helicone GitHub](https://github.com/Helicone/helicone)
- [Helicone Gateway Overview](https://docs.helicone.ai/gateway/overview)
- [Helicone LICENSE](https://raw.githubusercontent.com/Helicone/helicone/main/LICENSE)

### 4.8 Envoy AI Gateway、SMG、TensorZero：生产基础设施参考

这三类项目共同体现了更大规模的设计方向：

- Route / Backend / Policy 分离；
- Provider discovery；
- Kubernetes；
- circuit breaker；
- retry with backoff；
- rate limiting；
- Prometheus/OpenTelemetry；
- 多租户；
- 高可用和状态复制。

其中：

- Envoy AI Gateway 更适合 Kubernetes 和 Envoy Gateway 体系；
- SMG 更偏高性能、大规模多 worker 和多种路由策略；
- TensorZero 更偏 Gateway + Observability + Evaluation + Optimization 的 LLMOps 平台。

它们适合在后续需要多实例、共享状态、企业观测或 Kubernetes 部署时参考，不适合作为当前轻量 MVP 的默认依赖。

来源：

- [Envoy AI Gateway](https://github.com/envoyproxy/ai-gateway)
- [Envoy AI Gateway Docs](https://aigateway.envoyproxy.io/docs/)
- [SMG](https://github.com/smg-project/smg)
- [TensorZero](https://github.com/tensorzero/tensorzero)

## 5. 可复用的核心设计

### 5.1 把“Provider”拆成四层

不要把一个 URL 和一个 Key 直接建模成一个粗粒度 Provider。建议拆成：

```text
Provider
  - logical_name: openai-compatible-a
  - protocol: openai-responses
  - default_path: /v1/responses
  - model_aliases

Endpoint
  - provider_id
  - base_url
  - region
  - transport_timeout
  - enabled

Credential
  - endpoint_id
  - key_ref
  - key_fingerprint
  - models
  - weight
  - priority

Deployment
  - logical_model
  - provider_id
  - endpoint_id
  - credential_id
  - upstream_model
  - routing_policy
```

这样可以独立回答：

- 是 URL 挂了，还是 Key 挂了？
- 一个 endpoint 上还有没有其他 Key？
- 同一个模型能否切到另一个 Provider？
- 某个 Key 是否只支持部分模型？
- Responses 会话是否必须粘到原 deployment？

### 5.2 错误分类

建议第一版使用可配置的错误分类器：

| 上游结果 | 默认分类 | 默认动作 |
|---|---|---|
| 401 | credential_permanent | 当前请求淘汰 Key，进入下一个 Key |
| 403 | credential_permanent | 当前请求淘汰 Key，必要时长时间熔断 |
| 402 | billing_or_quota | 当前请求淘汰 Key，进入下一个 Key |
| 429 | rate_limited | 按 `Retry-After` 冷却；可以切 Key |
| 408 | timeout | 短暂冷却 endpoint 或 deployment |
| 500/502/503/504 | upstream_transient | 同 Key 重试，之后切 endpoint/provider |
| DNS/连接失败 | upstream_transient | 短暂冷却 endpoint |
| 400/404/422 | request_or_capability | 默认不切换，直接返回 |
| SSE 中途断开 | stream_interrupted | 不自动拼接第二个流，记录失败并返回可诊断错误 |

注意：

- 不同服务商可能用 200 响应体表达额度不足；
- 有些服务商会用 429 表示账户余额、并发或速率问题；
- 需要支持基于状态码、错误码、错误消息和 header 的 Provider-specific 规则；
- 错误分类规则本身应版本化并可测试。

### 5.3 重试预算和熔断状态要分离

至少需要三个不同的概念：

```text
request_retry_budget
provider_fallback_budget
cooldown_state
```

推荐顺序：

```text
选择 deployment
  -> 同 Key 处理网络/5xx retry
  -> 401/402/403/429 触发 Key 层策略
  -> 当前 Provider 的 Key 池耗尽
  -> 切换下一个 endpoint/provider
  -> 全部失败后返回可诊断错误
```

熔断状态至少分为：

- `healthy`
- `cooling_down`
- `permanently_disabled`
- `manual_disabled`

不要把所有失败都永久禁用。401/402/403 通常更接近凭证问题；5xx/DNS 往往只需要短暂冷却。

### 5.4 Responses 会话亲和性

Codex 场景不能只做无状态请求级轮询。建议保存：

```text
response_id -> deployment_id
response_id -> endpoint_id
response_id -> credential_id
```

处理规则：

1. 首次请求按普通路由选择 deployment；
2. 成功返回 `response.id` 后写入 affinity；
3. 后续携带 `previous_response_id` 的请求优先回到原 deployment；
4. 原 deployment 不可用时，判断请求是否能安全迁移；
5. 如果请求包含加密 reasoning 内容或 provider-specific item，优先返回明确的迁移错误，不要静默切换造成上下文损坏；
6. 如果客户端完整携带了可重放的 input/history，并且上游允许迁移，才考虑切换。

### 5.5 SSE 流式故障转移

一个请求可以分成两个阶段：

```text
首个有效事件之前
  - 可以尝试下一个 Key/endpoint

已经向客户端发送事件之后
  - 不应静默切换并拼接新 Provider 的流
```

原因：

- 已发送内容可能已经被 Codex 消费；
- 新 Provider 的 response ID、序号、tool call ID 和 reasoning 状态可能不同；
- 可能造成重复输出；
- 可能造成两次计费；
- 可能破坏工具调用状态。

因此第一版建议：

- 在收到首个有效 SSE event 前允许切换；
- 首个事件之后只负责转发、心跳、超时和断流诊断；
- 断流后返回结构化错误；
- 不做跨 Provider 的“半流拼接”；
- 后续如果实现可恢复流，需要单独设计 replay/idempotency 协议。

## 6. 推荐架构

```text
Codex
  |
  | OpenAI Responses API + SSE
  v
Relay HTTP API
  |
  +-- Auth Middleware
  |
  +-- Request Normalizer
  |
  +-- Model Alias Resolver
  |
  +-- Session Affinity Store
  |
  +-- Router
  |     |
  |     +-- Key Pool
  |     +-- Endpoint Pool
  |     +-- Provider Fallback
  |     +-- Retry Budget
  |     +-- Cooldown / Circuit Breaker
  |
  +-- Provider Adapter
  |     |
  |     +-- OpenAI Responses passthrough
  |     +-- Optional Chat Completions adapter
  |     +-- SSE parser/forwarder
  |
  +-- Audit / Metrics
  |
  +-- Admin API
        |
        +-- Provider
        +-- Endpoint
        +-- Credential
        +-- Model Alias
        +-- Routing Policy
```

建议第一版优先做单进程、SQLite 或文件配置；当需要多实例时，再把以下状态迁移到 Redis 或数据库：

- cooldown；
- response affinity；
- request attempt；
- usage counters；
- admin configuration。

## 7. 推荐配置草案

配置可以采用 YAML/TOML/JSON，核心结构建议保持类似下面的形式：

```yaml
server:
  listen: "127.0.0.1:8787"
  public_api_key_env: "RELAY_API_KEY"

models:
  codex:
    aliases:
      - "gpt-5-codex"
      - "gpt-5.1-codex"
    deployments:
      - id: openai-a-key-1
        provider: openai-compatible-a
        endpoint: https://api-a.example.com/v1
        upstream_model: gpt-5-codex
        api_key_env: UPSTREAM_A_KEY_1
        priority: 10
        weight: 1
      - id: openai-a-key-2
        provider: openai-compatible-a
        endpoint: https://api-a.example.com/v1
        upstream_model: gpt-5-codex
        api_key_env: UPSTREAM_A_KEY_2
        priority: 10
        weight: 1
      - id: openai-b-key-1
        provider: openai-compatible-b
        endpoint: https://api-b.example.com/v1
        upstream_model: gpt-5-codex
        api_key_env: UPSTREAM_B_KEY_1
        priority: 20
        weight: 1

policies:
  default:
    max_attempts: 4
    max_provider_fallbacks: 2
    retry_same_key_on:
      - network
      - 500
      - 502
      - 503
      - 504
    rotate_key_on:
      - 401
      - 402
      - 403
      - 429
    do_not_failover_on:
      - 400
      - 404
      - 422
    cooldown:
      rate_limit_seconds: 10
      transient_seconds: 30
      billing_seconds: 3600
      auth_seconds: 3600
```

真实密钥不应直接写入仓库配置。第一版可以使用环境变量，后续再接入系统 Keychain、Docker secrets、Vault 或 KMS。

## 8. MVP 开发路线

### Phase 1：单模型 Responses 中转

- `POST /v1/responses`；
- 非流式透传；
- `stream=true` 的 SSE 透传；
- 一个中转 API Key；
- 多个 deployment；
- 环境变量保存上游 Key；
- priority 路由；
- 401/402/403/429 切 Key；
- 5xx/网络错误短暂重试；
- 日志脱敏。

### Phase 2：Codex 会话和可靠性

- `previous_response_id`；
- response affinity；
- reasoning/tool call item 透传；
- Provider-specific 错误规则；
- cooldown 状态；
- request ID 和 attempt trail；
- 首个 SSE 事件前的安全故障转移；
- 全部 deployment 不可用时的结构化错误。

### Phase 3：管理和观测

- Provider/endpoint/credential 管理 API；
- 模型别名；
- 权重和条件路由；
- Prometheus metrics；
- 请求耗时、tokens、错误率、fallback 次数；
- 手动禁用/恢复 deployment；
- 余额/额度探测插件。

### Phase 4：多实例部署

- Redis 或数据库共享 cooldown；
- affinity 存储；
- 配置热加载；
- admin RBAC；
- Docker Compose；
- Kubernetes/Helm；
- 审计和告警。

## 9. 验收清单

### 路由

- [ ] 同一个模型可以配置多个 URL；
- [ ] 同一个 URL 可以配置多个 Key；
- [ ] Key 有独立的状态和 cooldown；
- [ ] URL 故障不会把同 URL 的其他 Key 一起误禁用；
- [ ] Key 故障不会把整个 Provider 永久禁用；
- [ ] priority、weight、fallback 行为有单元测试。

### 错误处理

- [ ] 401/403 能切换 Key；
- [ ] 402 或 Provider-specific 余额错误能切换 Key；
- [ ] 429 遵循 Retry-After；
- [ ] 5xx/网络错误有指数退避；
- [ ] 400/404/422 默认不盲目切换；
- [ ] 所有尝试都有脱敏记录；
- [ ] retry budget 不会因为 fallback 无限放大。

### Responses/Codex

- [ ] `/v1/responses` 非流式透传；
- [ ] `/v1/responses` 流式事件透传；
- [ ] 不使用 Chat Completions 的 `[DONE]` 规则替代 Responses 事件结束；
- [ ] `response.created`、文本 delta、tool call、completed/failed 等事件不丢失；
- [ ] `previous_response_id` 能维持 deployment affinity；
- [ ] reasoning 字段不被无意删除或重构；
- [ ] 首个 SSE 事件前可以安全 failover；
- [ ] 首个 SSE 事件后不会静默拼接第二个 Provider；
- [ ] 请求取消能正确关闭上游连接。

### 安全

- [ ] Codex 只看到中转 Key；
- [ ] 上游 Key 不写日志；
- [ ] 上游 Key 不返回给管理 API；
- [ ] 配置文件权限受控；
- [ ] 管理面和数据面可以分开认证；
- [ ] 记录每次上游调用的 Provider/endpoint/key fingerprint，而不是明文 Key。

## 10. 许可证和使用边界

调研项目的许可证差异很大：

- MIT：LiteLLM 主体、Portkey Gateway、Floway、One API；
- Apache-2.0：Bifrost、Helicone、Envoy AI Gateway、SMG、TensorZero；
- AGPL-3.0：New API；
- PolyForm Noncommercial 1.0.0：Gozar。

这份文档只用于架构和实现参考，不代表可以直接复制代码。若直接移植实现，应：

1. 固定上游仓库 commit/tag；
2. 保存许可证和版权声明；
3. 检查子目录、依赖和生成代码是否有不同许可证；
4. 特别评估 AGPL、PolyForm 和 LiteLLM `enterprise/` 目录；
5. 确认多个上游账户、Key 和额度的使用符合各上游服务条款。

## 11. 最终建议

本项目不建议一开始直接 fork 一个大型 LLM Gateway。更稳妥的实现路径是：

1. 以 **Floway** 的 Coding Agent / Stateful Responses 方向作为产品目标参考；
2. 以 **Bifrost** 的错误分类和多 Key rotation 作为路由核心参考；
3. 以 **LiteLLM** 的 Responses affinity 解决会话连续性；
4. 以 **Portkey** 的配置树和 circuit breaker 设计配置格式；
5. 以 **Helicone** 的 trace、成本和指标设计观测层；
6. 后续需要云原生和多实例时，再参考 Envoy AI Gateway、SMG、TensorZero。

第一版的核心原则：

> 先保证 Responses 协议和 Codex 会话正确，再增加更多 Provider、格式转换和管理功能。

