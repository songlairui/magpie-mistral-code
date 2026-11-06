# @solary/magpie-mistral-vibe

Mistral **Vibe Code** 订阅作为 OpenCode / magpie 的 provider 插件（非官方）。Provider id 为
`mistral-vibe`，与 magpie 内置的 `mistral` preset（api.mistral.ai + 自己的 API key，按
API credits 计费）相互独立：本插件的登录拿到的是 **Vibe Code 套餐 key**，请求同样走
`https://api.mistral.ai/v1`，但用量计入套餐的月度 Vibe Code 预算。

## 登录

- **浏览器登录**（默认）：与官方 `mistral-vibe` CLI 相同的流程 ——
  `POST console.mistral.ai/api/vibe/sign-in`（PKCE S256）→ 打开返回的 `sign_in_url` →
  轮询 `poll_url` → `POST /api/vibe/sign-in/{process_id}/exchange` 拿到 API key。
- **API key**：直接粘贴在 console.mistral.ai 的 Code > Vibe Code CLI 下创建的 key。

## 用量

`GET api.mistral.ai/v1/billing/budget`（`vibe_budget.usage_percentage` / `reset_at`）和
`GET /v1/billing/subscription`（plan 名），即官方 CLI 自己的 billing 读取；plan 也来自
`console.mistral.ai/api/vibe/whoami`。

## 安装

magpie 里 `magpie plugin add github:songlairui/magpie-mistral-code#v0.1.0`（打 tag 安装），
然后 `magpie plugin login mistral-vibe`。OpenCode 里把包名加进配置即可。

模型列表来自 `GET /v1/models`，limit 优先取 models.dev 的 `mistral` 目录。

## 测试

```sh
bun test
```
