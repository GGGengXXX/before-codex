# Codex Relay 用户文档

最后更新：2026-08-21

这是一份给日常使用者看的快速说明。目标很简单：让 Codex 只连一个稳定地址，后面的多个上游 URL 和 API Key 交给中转站自动处理。

## 这是做什么的

你只需要把 Codex 指向本地的 Codex Relay。Relay 会根据配置挑选上游 deployment，并在下面这些情况自动切换：

- 某个 key 余额不足或配额耗尽
- 某个 key 被限流
- 某个上游临时故障、超时或网络不通

你不用手工改 Codex 配置里的 URL，也不用每次出问题都去换 key。

## 快速开始

### 1. 准备配置文件

```bash
cp config.example.json config.json
```

### 2. 启动服务

```bash
npm start
```

默认会监听 `http://127.0.0.1:8787`。

### 3. 在网页端填写密钥

管理控制台：

```text
http://127.0.0.1:8787/admin
```

第一次启动时，服务会自动生成内部使用的 `RELAY_API_KEY` 和 `RELAY_ADMIN_KEY`。本机打开管理控制台不需要手动填写 Admin Key。进入后在 Secrets 区域填写上游 API Key：

```dotenv
UPSTREAM_A_KEY_1=your-upstream-key-1
UPSTREAM_A_KEY_2=your-upstream-key-2
UPSTREAM_B_KEY_1=your-upstream-key-3
```

点击 Secrets 区域的 `Save` 后，服务会把这些值写到本地 `.env`，并自动热更新。

`.env` 已经在 `.gitignore` 里，不会被提交。启动时项目会自动读取它。

![Codex Relay 管理控制台](assets/admin-console.png)

## 配置 Codex

最简单的方式是在管理控制台左侧切换：

- 选择 `openai`：Codex 使用默认 OpenAI provider，不经过中转站
- 选择 `relay`：Codex 使用 Codex Relay

点击 `Apply Provider` 后，网页端会同时更新：

- `~/.codex/config.toml`
- `~/.codex/state_5.sqlite` 里已有任务的 `model_provider`

如果你点的是顶部 `Save + Reload`，它也会在保存配置后同步当前选中的 `openai` 或 `relay`，所以不必再额外点一次 `Apply Provider`。

切到 `relay` 时，生成的配置类似这样：

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

这个 auth command 会自动从 `.env` 读取内部 relay token，所以你不需要在终端里手动 `export RELAY_API_KEY`。

## 配置上游 key

在 `config.json` 里，一个 deployment 代表一个“URL + Key + 模型”的组合。

示例：

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

建议这样理解：

- `priority` 越小越优先
- 同优先级会按 `weight` 轮转
- 同一个 provider 可以挂多个 key
- 某个 key 失效后，Relay 会自动尝试下一个可用 deployment

在网页端的 Quick 页面，只需要填：

- `API`：可以是真实 key，也可以是 `env:NAME`
- `model_provider`：上游/provider 名称
- `base_url`：上游 OpenAI-compatible `/v1` 地址
- `model`：上游实际模型名

如果只想用某一个 API，点击它的 `Only This`；如果想让多个 API 互为备用，就保持它们都是 `enabled`。

左侧的 `Routes` 是“Codex 模型名映射”。比如 Codex 请求 `codex`，Relay 会先找到这个 route，再从该 route 下面的 API 列表里选择真实上游 `base_url + API key + model`。平时新增上游接口用 `APIs` 里的 `Add API`；只有想新增一个 Codex 可选择的模型名时，才使用 `Add Route`。

## 怎么验证是否可用

先看状态页：

![Codex Relay 状态页](assets/status-page.png)

也可以直接检查健康状态：

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/readyz
```

如果你想看当前部署状态：

```bash
curl http://127.0.0.1:8787/api/status/public
```

管理控制台的 `Overview` 可以切换 `Week / Month / Year`。`Year` 是类似 GitHub contribution 的 token 热力图，适合看长期调用活跃度；`Logs` 支持分页，调用多了也不会把页面无限拉长。

## 常见用法

### 网页端保存并热更新

访问：

```text
http://127.0.0.1:8787/admin
```

输入管理 key 后，修改 API 或详细 JSON，再点击 `Save + Reload`。保存会先校验配置，校验通过后才覆盖文件、热更新运行时，并同步当前选中的 Codex Provider。

### 重新加载配置

修改 `config.json` 之后，可以不用重启进程，直接热加载。日常建议直接点网页端的 `Save + Reload`；命令行调试时可以这样做：

```bash
source .env
curl -X POST http://127.0.0.1:8787/admin/reload \
  -H "Authorization: Bearer $RELAY_ADMIN_KEY"
```

### 发送请求

Relay 暴露的是 Responses API：

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

### 开流式输出

把 `"stream": true` 打开即可：

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

## 出问题时先看什么

- `401/403`：多半是上游 key 无效
- `402` 或余额类报错：Relay 会自动换下一个 key
- `429`：当前 key 被限流，会进入冷却
- `5xx` 或网络错误：Relay 会尝试其他 deployment
- `ready` 但还是不通：看 `/api/status` 里的具体 deployment 状态

## 小提醒

- 不要把真实上游 key 直接写进 `config.json`
- `RELAY_API_KEY` 和 `RELAY_ADMIN_KEY` 是内部使用的本地 token，会自动生成并在网页端隐藏
- 监听地址和端口改动后需要重启
- token 统计、调用日志和 cooldown 默认保存在 `.codex-relay-state.json`，服务重启后不会丢
- 这是一个本机/同机优先的中转站，不是分布式控制面
