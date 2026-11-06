# @solary/magpie-mistral-vibe

<img src="assets/icon.svg" width="72" height="72" alt="Mistral Vibe Code">

Mistral **Vibe Code** 订阅作为 OpenCode / magpie 的 provider 插件（非官方）。Provider id 为
`mistral-vibe`，与 magpie 内置的 `mistral` preset（api.mistral.ai + 自己的 API key，按
API credits 计费）相互独立：本插件的登录拿到的是 **Vibe Code 套餐 key**，请求同样走
`https://api.mistral.ai/v1`，但用量计入套餐的月度 Vibe Code 预算。

> 非官方插件，与 Mistral AI 没有隶属或背书关系；Mistral 名称与商标归 Mistral AI 所有。
> 图标是本插件自己的原创标识。

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

模型列表来自 `GET /v1/models`：context 优先取它自己的 `max_context_length`，名称、输出
上限和能力优先取 models.dev 的 `mistral` 目录，接口的 `capabilities` 优先于 models.dev。

## 价格

价格对齐 [Mistral 官方定价](https://docs.mistral.ai/inference/pricing)（USD / 1M tokens，
standard 档），覆盖当前在售的 LLM 模型：

| 模型 | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| Mistral Large 4 | 0.70 | 0.07 | 2.10 |
| Mistral Small 4 | 0.15 | 0.015 | 0.60 |
| Ministral 3 14B | 0.20 | 0.02 | 0.20 |
| Ministral 3 8B | 0.15 | 0.015 | 0.15 |
| Ministral 3 3B | 0.10 | 0.01 | 0.10 |
| Codestral | 0.30 | 0.03 | 0.90 |
| Z.ai GLM 5.3 Flash | 0.15 | 0.03 | 0.50 |
| Z.ai GLM 5.3 | 1.40 | 0.14 | 4.40 |
| DeepSeek V4.1 Flash 1017 | 0.30 | 0.007 | 1.20 |

`/v1/models` 的 `billing_model_name` 决定别名按哪个模型计价，所以 `codestral-latest`、
`mistral-code-latest` 等别名会和它背后的 `codestral-2508` 同价；`mistral-large-latest`
仍按它实际结算的 Mistral Large 3 计价，不会误标成 Large 4。旧版本和语音、OCR、embedding
模型不在上面的表里，若 models.dev 认识它们就沿用 models.dev 的价格；都不认识时宁可不标价，
也不写 0。

## 测试

```sh
bun test
```
