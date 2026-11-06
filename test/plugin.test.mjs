// Tests against a stand-in for console.mistral.ai and api.mistral.ai: the
// browser sign-in (start → poll → exchange), the request loader's signing,
// the billing usage read and the model list. Set the bases to the mock's own
// URLs; the plugin reads them per call, so this works whatever order the
// tests run in.
import { afterEach, expect, test } from "bun:test"
import { MistralVibeAuthPlugin, _internal } from "../index.mjs"

const realFetch = globalThis.fetch

process.env.MISTRAL_VIBE_API_BASE = "http://mock.local/v1"
process.env.MISTRAL_VIBE_CONSOLE_API = "http://mock.local/api"

const KEY = "vibe-key-1"
const state = { polls: 0, chats: [], exchanges: [], whoamis: 0, modelsCalls: 0 }

function mockFetch() {
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input)
    const u = new URL(url)
    const h = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } })

    if (u.pathname === "/api/vibe/sign-in" && init.method === "POST") {
      const body = JSON.parse(init.body)
      if (!body.code_challenge || body.code_challenge_method !== "S256") return json({ error: "bad challenge" }, 400)
      return json({
        process_id: "p1",
        sign_in_url: "https://console.mistral.ai/login?process=p1",
        poll_url: "http://mock.local/api/vibe/sign-in/p1/poll",
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      })
    }
    if (u.pathname === "/api/vibe/sign-in/p1/poll") {
      state.polls++
      return state.polls < 2 ? json({ status: "pending" }) : json({ status: "completed", exchange_token: "et-1" })
    }
    if (u.pathname === "/api/vibe/sign-in/p1/exchange" && init.method === "POST") {
      const body = JSON.parse(init.body)
      state.exchanges.push(body)
      if (body.exchange_token !== "et-1" || !body.code_verifier) return json({ error: "bad exchange" }, 400)
      return json({ api_key: KEY })
    }
    if (u.pathname === "/api/vibe/whoami") {
      state.whoamis++
      if (h.get("authorization") !== `Bearer ${KEY}`) return json({ error: "unauthorized" }, 401)
      return json({ plan_name: "Vibe Pro", plan_type: "pro", has_paid_vibe_entitlement: true, customer_id: "cust-1" })
    }
    if (u.pathname === "/v1/chat/completions" && init.method === "POST") {
      state.chats.push(h.get("authorization"))
      return json({ id: "chatcmpl-1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    }
    if (u.pathname === "/v1/models") {
      state.modelsCalls++
      if (h.get("authorization") !== `Bearer ${KEY}`) return json({ error: "unauthorized" }, 401)
      return json({ object: "list", data: [{ id: "mistral-large-4" }, { id: "devstral-2" }] })
    }
    if (u.pathname === "/v1/billing/subscription")
      return json({ plan_name: "Vibe Pro", vibe_payg_enabled: true })
    if (u.pathname === "/v1/billing/budget")
      return json({ vibe_budget: { usage_percentage: 42.5, initial_budget: 100, reset_at: "2099-01-01T00:00:00Z", payg_enabled: true } })
    return json({ error: `unexpected ${init.method ?? "GET"} ${u.pathname}` }, 404)
  }
}

afterEach(() => {
  globalThis.fetch = realFetch
})

const plugin = async () => {
  const hooks = await MistralVibeAuthPlugin({ client: { auth: { set: async () => {} } } })
  return hooks
}

test("config declares the mistral-vibe provider", async () => {
  const hooks = await plugin()
  const cfg = { provider: {} }
  await hooks.config(cfg)
  expect(cfg.provider["mistral-vibe"].name).toBe("Mistral Vibe Code")
  expect(cfg.provider["mistral-vibe"].api).toBe("http://mock.local/v1")
  expect(cfg.provider["mistral-vibe"].npm).toBe("@ai-sdk/openai-compatible")
  expect(hooks.auth.provider).toBe("mistral-vibe")
})

test("browser sign-in: start, poll to completed, exchange for a Vibe-budget key", async () => {
  mockFetch()
  const hooks = await plugin()
  const oauth = hooks.auth.methods.find((m) => m.type === "oauth")
  expect(oauth).toBeTruthy()
  const started = await oauth.authorize()
  expect(started.url).toBe("https://console.mistral.ai/login?process=p1")
  expect(started.method).toBe("auto")
  const result = await started.callback()
  expect(result.type).toBe("success")
  expect(result.key).toBe(KEY)
  expect(result.accountId).toBe("cust-1")
  expect(state.exchanges).toHaveLength(1)
  expect(state.exchanges[0].exchange_token).toBe("et-1")
  expect(typeof state.exchanges[0].code_verifier).toBe("string")
})

test("sign-in reports denial and expiry", async () => {
  const hooks = await plugin()
  const oauth = hooks.auth.methods.find((m) => m.type === "oauth")
  // poll answer forced to denied
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input))
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } })
    if (u.pathname === "/api/vibe/sign-in") return json({ process_id: "p2", sign_in_url: "https://x/", poll_url: "http://mock.local/api/vibe/sign-in/p2/poll", expires_at: new Date(Date.now() + 60_000).toISOString() })
    if (u.pathname.endsWith("/poll")) return json({ status: "denied", message: "nope" })
    return json({}, 404)
  }
  const started = await oauth.authorize()
  const r = await started.callback()
  expect(r.type).toBe("failed")
  expect(r.error).toContain("nope")
})

test("loader signs each request with the account key", async () => {
  mockFetch()
  const hooks = await plugin()
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: KEY }))
  expect(loader.baseURL).toBe("http://mock.local/v1")
  const res = await loader.fetch("http://mock.local/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer stale" }, body: "{}" })
  expect(res.status).toBe(200)
  expect(state.chats).toEqual([`Bearer ${KEY}`])
  const j = await res.json()
  expect(j.choices[0].message.content).toBe("hi")
})

test("loader with no sign-in returns no options", async () => {
  const hooks = await plugin()
  expect(await hooks.auth.loader(async () => null)).toEqual({})
})

test("usage reads the monthly Vibe Code budget and the plan", async () => {
  mockFetch()
  const hooks = await plugin()
  const u = await hooks.auth.usage(async () => ({ type: "api", key: KEY }))
  expect(u.plan).toBe("Vibe Pro")
  expect(u.windows).toHaveLength(1)
  expect(u.windows[0].used).toBe(42.5)
  expect(u.windows[0].resetsAt).toBe(Date.parse("2099-01-01T00:00:00Z"))
  expect(u.windows[0].span).toBeGreaterThan(3600)
})

test("usage without a sign-in says so", async () => {
  const hooks = await plugin()
  const u = await hooks.auth.usage(async () => null)
  expect(u.windows).toEqual([])
  expect(typeof u.error).toBe("string")
})

test("provider.models lists /v1/models as mistral-vibe models", async () => {
  mockFetch()
  const hooks = await plugin()
  const models = await hooks.provider.models({ models: {} }, { auth: { type: "api", key: KEY } })
  expect(Object.keys(models).sort()).toEqual(["devstral-2", "mistral-large-4"])
  expect(models["mistral-large-4"].tool_call).toBe(true)
  expect(models["mistral-large-4"].limit.context).toBeGreaterThan(0)
})

test("provider.models falls back to the provider's own list when the key is refused", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
  const hooks = await plugin()
  const fallback = { models: { "mistral-large-4": { name: "Mistral Large 4" } } }
  const models = await hooks.provider.models(fallback, { auth: { type: "api", key: "bad" } })
  expect(models).toEqual(fallback.models)
})

test("api method is offered for pasting a Vibe Code key", async () => {
  const hooks = await plugin()
  const api = hooks.auth.methods.find((m) => m.type === "api")
  expect(api).toBeTruthy()
  expect(typeof api.placeholder).toBe("string")
})
