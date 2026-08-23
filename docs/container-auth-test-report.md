# Before Codex 隔离容器测试报告

## 测试元数据

- 测试时间：2026-08-23（Asia/Shanghai）
- 项目：当前工作区源码（包含账号/profile 隔离、Responses SSE 兼容修复）
- 镜像：`before-codex:latest`
- 基础环境：Ubuntu 22.04、Node.js 20.19.5、Codex CLI 0.149.0
- 容器：`before-codex-test`
- 容器端口：`28787 -> 8787`
- 说明：宿主机 `8787` 已有 Node relay 监听，因此使用 `28787` 避免请求被其他进程接收。容器内部仍监听 `0.0.0.0:8787`。
- 上游：本轮使用容器内 mock Responses 上游验证权限和 profile 路由；真实 API 测试等待用户提供专用测试凭据。

## 测试目标

验证以下安全边界：

1. 没有 Bearer token 的公共请求不能使用 `/v1` API。
2. 公共用户 token 不能使用新注册用户的私有 API 配置。
3. 用户注册、登录后，在该用户 profile 中配置 API，可以成功调用 `/v1/responses`。
4. 错误密码返回明确的 `401 invalid_credentials`，而不是服务端 `500`。

## 关键路径和证据

### 1. 容器和运行时

```text
v20.19.5
10.8.2
codex-cli 0.149.0
healthz=200
```

启动日志：

```text
{"event":"relay_started","listen":"0.0.0.0:8787","config":"/app/config.json","models":["codex"],"deployments":1,"auth":{"public_api_key":true,"admin_api_key":true}}
Codex Relay is ready at http://0.0.0.0:8787
```

### 2. 未登录请求

请求：`POST /v1/responses`，不带 Authorization。

```text
HTTP 401 {"type":"unauthorized","message":"Bearer token required"}
```

判定：**OK**。未登录不能调用 API。

### 3. 公共用户在没有 API 配置时调用

请求使用公共 token `guest-test-token`，但公共 profile 没有启用 deployment。

```text
HTTP 502 {"type":"upstream_exhausted","message":"All configured upstream deployments failed for \"gpt-test\""}
```

判定：**OK**。公共 profile 没有可用 API，不会借用其他用户的 API。

### 4. 注册并登录新用户

```text
HTTP 200 username=testuser1787472958 token=user-REDACTED
```

判定：**OK**。账号创建成功，token 已脱敏。

### 5. 用户在自己的 profile 添加 API

```text
HTTP 200 profile=testuser1787472958 deployment=1
```

判定：**OK**。配置保存到用户 profile，并只加载 1 个用户 deployment。

### 6. 已登录用户调用真实 relay 数据面

请求使用该用户登录 token，调用 `POST /v1/responses`。

```text
HTTP 200 id=resp_test_mock text=MOCK_OK:logged-in usage_total=2
```

判定：**OK**。用户 token 被路由到对应 profile，Responses 返回和 usage 均正常。

### 7. 公共用户隔离验证

再次使用公共 token 调用同一模型：

```text
HTTP 502 {"type":"upstream_exhausted","message":"All configured upstream deployments failed for \"gpt-test\""}
```

判定：**OK**。公共用户仍不能使用新用户 profile 中的 API。

### 8. 登录错误语义

```text
CASE 7 login with wrong password
HTTP 401 {"type":"invalid_credentials","message":"Invalid username or password"}
CASE 8 login success
HTTP 200 username=testuser1787472958 token=user-REDACTED
```

判定：**OK**。已修复错误密码返回 `500` 的问题。

## 自动化回归

```text
npm run check                         PASS
npm test                              PASS
1..62
# tests 62
# pass 62
# fail 0
```

## 真实 API 测试状态

本报告尚未包含真实上游调用。请提供一个专用、可撤销、低额度的测试 API，至少包含：

- `base_url`（例如 `https://.../v1`）
- 上游模型名
- API Key
- 如有需要，额外的 Header 名和值

凭据只会通过容器运行时环境或临时挂载注入，不会写入 Git、报告或终端输出。真实测试将覆盖：非流式 Responses、流式 Responses、错误 token、用户 profile 成功调用和公共 profile 隔离，并把状态码、响应事件和关键日志脱敏追加到本报告。

## 清理和进入容器

当前测试容器仍在运行，可进入：

```bash
docker exec -it before-codex-test bash
```

停止并删除测试容器：

```bash
docker rm -f before-codex-test
```
