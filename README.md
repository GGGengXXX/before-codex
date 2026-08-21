# Codex Relay

一个面向 Codex 的轻量 OpenAI Responses 中转站。

它让 Codex 只连接一个稳定的 `/v1` 地址，而把多个上游 URL、API Key、优先级和故障转移逻辑放在服务端管理。

当前版本支持：

- `POST /v1/responses`
- Responses API SSE 流式转发
- 多 URL、多 Key
- 401/402/403/429 Key 级切换
- Provider-specific 错误分类规则
- 408/5xx/网络错误重试和冷却
- 请求超时覆盖上游响应体和 SSE 读取阶段
- 客户端取消时中止上游且不触发错误重试
- `previous_response_id` 会话亲和性
- `/v1/models`
- `/healthz`、`/readyz`
- 公开状态页和管理状态接口
- 网页管理控制台：配置编辑、保存并热更新、Codex provider 切换
- 调用看板：最近调用、各 API token 累计、最近使用模型
- API 测试：在网页端保存并测试单个 deployment，结果进入调用日志
- 运行看板：Overview/Logs/APIs 分页，支持周/月/年 token 图表、年热力图、延迟和健康度对比
- 受保护的配置热加载
- 默认文件状态后端，用于持久化 cooldown、统计、调用日志和 affinity
- 网页端 Secrets 管理，避免把真实密钥写入配置

## 快速开始

需要 Node.js 20 或更高版本。项目只使用 Node.js 原生模块，不需要安装依赖。

```bash
cp config.example.json config.json
npm start
```

启动后：

- 状态页：<http://127.0.0.1:8787/>
- 管理控制台：<http://127.0.0.1:8787/admin>
- 健康检查：<http://127.0.0.1:8787/healthz>
- 就绪检查：<http://127.0.0.1:8787/readyz>
- 模型列表：`GET http://127.0.0.1:8787/v1/models`
- 管理状态：`GET http://127.0.0.1:8787/api/status`
- 热加载配置：`POST http://127.0.0.1:8787/admin/reload`

第一次启动时，服务会自动生成内部使用的 `RELAY_API_KEY` 和 `RELAY_ADMIN_KEY` 并写入 `.env`。本机打开 `/admin` 时无需手动输入 Admin Key；Secrets 区只需要填写上游 API Key：

```dotenv
UPSTREAM_A_KEY_1=your-upstream-key-1
UPSTREAM_A_KEY_2=your-upstream-key-2
UPSTREAM_B_KEY_1=your-upstream-key-3
```

点击 `Save` 后会写入本地 `.env` 并热加载。

如果需要使用其他配置文件：

```bash
npm start -- --config /absolute/path/to/config.json
```

如果需要使用其他 `.env` 文件：

```bash
npm start -- --env /absolute/path/to/.env
```

`.env` 会在启动时自动读取；已经在 shell 里设置过的环境变量优先生效。

## 配置热加载

日常推荐直接用网页端的 `Save + Reload`。它会保存配置、热更新 runtime，并把当前选中的 Codex Provider 同步到 `~/.codex/config.toml` 和 `~/.codex/state_5.sqlite`。如果你在命令行里手动修改了 `config.json`，也可以让服务重新读取配置，不需要重启进程：

```bash
source .env
curl -X POST http://127.0.0.1:8787/admin/reload \
  -H "Authorization: Bearer $RELAY_ADMIN_KEY"
```

成功响应会返回新的模型和 deployment 数量以及 `reloaded_at`。热加载会保留当前进程中的 cooldown、请求统计和 Responses affinity。配置文件解析或校验失败时，旧配置继续服务；监听地址和端口的变化需要重启进程才能生效。

## 运行时状态和多实例

默认使用文件状态，运行数据会写入项目根目录的 `.codex-relay-state.json`。这意味着服务重启后仍然保留 token 统计、调用日志、cooldown、请求统计和 Responses affinity。需要同机启动多个 relay 实例时，可以让它们共享一个明确的状态文件：

```json
{
  "state": {
    "store": "file",
    "file_path": "/var/lib/codex-relay/runtime-state.json",
    "lock_timeout_ms": 1000,
    "stale_lock_ms": 5000
  }
}
```

共享文件后，多个实例可以看到：

- deployment cooldown；
- 请求尝试、成功、失败统计；
- `previous_response_id -> deployment` affinity；
- 同优先级 deployment 的轮转游标。

状态文件不保存 API Key，但会保存 deployment 状态、错误摘要、Responses ID、最近调用预览和按天 token 统计，应设置合适的文件权限。该后端适合同机多进程或可靠的共享卷；跨机器、多副本生产部署建议下一步接入 Redis 或数据库。修改 `state` 配置后需要重启进程，`/admin/reload` 不会替换已经创建的状态后端。

## Codex 配置

推荐在管理控制台左侧的 `Codex Provider` 里切换 `openai` 或 `relay`。切到 `relay` 时，服务会自动写入 `~/.codex/config.toml`，并使用本地 auth command 从 `.env` 读取内部 relay token，所以不需要你手动 export `RELAY_API_KEY`。

网页端生成的配置类似这样：

```toml
model_provider = "relay"

[model_providers.relay]
name = "Codex Relay"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"

[model_providers.relay.auth]
command = "node"
args = ["/absolute/path/to/scripts/relay-token.mjs", "/absolute/path/to/.env", "RELAY_API_KEY"]
```

配置中的 `model` 必须能在 `config.json` 的模型名或 `aliases` 中找到，例如 `codex`、`gpt-5-codex` 或 `gpt-5.1-codex`。

## 手动验证

查看中转站暴露的模型：

```bash
source .env
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $RELAY_API_KEY"
```

发送一个非流式 Responses 请求：

```bash
source .env
curl http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $RELAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5-codex",
    "input": "Reply with one short sentence.",
    "stream": false
  }'
```

发送一个流式请求：

```bash
source .env
curl -N http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $RELAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5-codex",
    "input": "Reply with one short sentence.",
    "stream": true
  }'
```

## 配置思路

每个 deployment 是一个独立的“URL + Key + 上游模型”组合：

```json
{
  "id": "provider-a-key-1",
  "provider": "provider-a",
  "base_url": "https://api-a.example.com/v1",
  "model": "gpt-5-codex",
  "api_key": "env:UPSTREAM_A_KEY_1",
  "priority": 10,
  "weight": 1,
  "enabled": true
}
```

- `priority` 越小越优先；
- 同优先级 deployment 按 `weight` 参与轮转，`weight` 越大，在同一优先级组里被分到的流量越多；
- 同一 Provider 的多个 Key 可以互相切换；
- 402 或“余额不足/配额耗尽”类错误会淘汰当前 Key；
- 429 会冷却当前 Key，并尝试其他 Key；
- 5xx、DNS、连接失败会短暂冷却当前 deployment；
- 400、404、422 默认直接返回，不盲目换 Key。
- 上游响应头已经返回后，`request_timeout_ms` 仍然继续约束响应体或 SSE 的读取时间；
- SSE 首个有效事件之前允许 failover；
- SSE 首个有效事件之后只有收到 `response.completed`、`response.failed`、`response.incomplete` 或 `[DONE]` 才算正常结束；
- 首事件后断流会记录为临时故障并冷却当前 deployment，但不会拼接另一个 Provider 的流；
- 客户端主动断开会取消上游请求，不会因为客户端行为触发 deployment 冷却或备用 Provider 重试。

网页管理控制台的 `Overview` 和 `Logs` 会显示最近一次实际调用的上游模型、token 用量和返回预览。

Codex 里设置的模型强度仍会按原始请求参数透传给上游；中转站不再按强度自动改写真实模型。

在每个 API 卡片上点击 `Test` 会先保存并热加载当前配置，再向该 deployment 发送一条很短的测试请求。测试结果会进入 `Logs` 的最近调用列表；点击一条调用可以查看真实上游模型、耗时、token 和返回文本预览。

管理控制台的 Quick 页分为三个工作区：

- `Overview`：查看周/月/年 token 图表、年热力图、调用量、平均延迟、失败数和不同模型的健康度对比；
- `Logs`：分页查看最近调用，可滚动浏览，点击单条记录打开详情；
- `APIs`：编辑 API、测试 API、调整 priority 和 weight。

调用详情支持 `Summary` 和 `JSON` 两种视图。

左侧的 `Routes` 是“Codex 模型名映射”。比如你在 Codex 里输入 `codex` 或 `gpt-5-codex`，Relay 会在这里找到对应 route，再从该 route 下面的 API 列表中选择真实上游 `base_url + api_key + model`。只有当你希望新增一个 Codex 可选择的模型名时，才需要点 `Add Route`；普通新增上游 API 点 `APIs` 里的 `Add API` 即可。

在 `Codex Provider` 里切换 `openai` 或 `relay` 时，服务会同时更新：

- `~/.codex/config.toml` 的顶层 `model_provider`；
- `~/.codex/state_5.sqlite` 中 `threads` 表所有记录的 `model_provider` 字段。

`Apply Provider` 会只同步 provider；`Save + Reload` 会在保存配置后顺手同步当前选中的 provider。

Provider 返回的错误语义不完全一致时，可以在 `routing.provider_error_rules` 中按 Provider 增加状态码、错误 code 或消息片段：

```json
{
  "routing": {
    "provider_error_rules": {
      "provider-a": {
        "billing_codes": ["credits_depleted"],
        "rate_limit_statuses": [409],
        "non_retryable_statuses": [400, 404, 422]
      }
    }
  }
}
```

自定义规则优先于通用规则；没有匹配到自定义规则时，仍使用内置的 401/402/403/429/5xx 判断。`non_retryable_statuses` 可用于明确禁止某个 Provider 的状态触发 failover。

## Responses 兼容过滤

部分第三方 OpenAI-compatible Provider 会返回非官方格式的 Responses item ID，例如把 reasoning item 写成 `item_*`。Codex 会把这些 item 保存进本地会话历史；之后切回官方 OpenAI 或更严格的上游时，历史 replay 可能报：

```text
Invalid 'input[n].id': 'item_...'. Expected an ID that begins with 'rs'.
```

Relay 默认开启兼容过滤：

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

它会在请求侧移除旧历史里的非法 reasoning item，也会在响应侧阻止新的非法 reasoning item 写入 Codex 历史。不要把 `item_*` 伪造成 `rs_*`；这些 ID 可能代表上游私有状态，改前缀并不能让官方 OpenAI 认识它。

## 安全建议

- 不要把真实上游 Key 写入 `config.json`；
- 使用 `env:NAME` 或 `${NAME}`；
- `RELAY_API_KEY` 和 `RELAY_ADMIN_KEY` 默认自动生成在 `.env`，网页端会隐藏它们，通常不需要手动处理；
- 生产环境把监听地址改为内网地址，并在反向代理层启用 HTTPS；
- 公开 API 内部使用 `RELAY_API_KEY`；
- 管理接口内部使用独立的 `RELAY_ADMIN_KEY`；
- `/admin/reload` 和 `/api/status` 共用管理 bearer token；
- 状态页不会显示完整 URL 或任何 Key；
- 默认运行时状态保存在 `.codex-relay-state.json`，重启后仍保留 cooldown、affinity、token 统计和调用日志；
- 文件状态后端不是跨机器分布式一致性方案，跨节点部署仍需要 Redis 或数据库。

## 开发和验证

```bash
npm run check
npm test
npm run dev -- --config config.json
```

用户文档在这里：

[docs/user-guide.md](docs/user-guide.md)

过程性设计记录在：

[docs/implementation-log.md](docs/implementation-log.md)

开源项目调研记录在：

[docs/opensource-research.md](docs/opensource-research.md)

## 当前边界

- 默认是文件状态；可通过自定义 `state.file_path` 支持同机多实例共享；
- 配置修改可以通过 `/admin/reload` 热加载，监听地址和端口变化仍需要重启；
- 状态后端在进程启动时创建，热加载不会切换 memory/file；
- SSE 首个有效事件发出后，如果上游中途断流，不会拼接另一个 Provider 的流；
- 当前重点是 `/v1/responses`，没有把所有 OpenAI 资源接口都代理出来。
