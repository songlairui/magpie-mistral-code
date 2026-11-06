// Mistral Vibe Code, as an OpenCode provider plugin (unofficial), served the
// way the official mistral-vibe CLI serves it:
//
// - Sign-in is the browser sign-in the CLI does: POST console.mistral.ai's
//   /api/vibe/sign-in with a PKCE challenge, the page it answers with is
//   opened, its poll_url is read until the browser has signed in, and
//   POST /api/vibe/sign-in/{process_id}/exchange (exchange_token +
//   code_verifier) returns an API key. That key is made for Vibe Code: its
//   calls on api.mistral.ai bill the plan's monthly Vibe Code budget, not
//   pay-as-you-go API credits. A key made the same way in the console
//   (Code > Vibe Code CLI) can be pasted instead.
// - Requests are plain OpenAI chat completions on https://api.mistral.ai/v1
//   with the key as a bearer token; the models are /v1/models. No private
//   protocol (the CLI's ACP layer is its IDE control plane, not its model
//   channel), so the loader re-signs each request, and puts an earlier
//   turn's thinking back in the typed part Mistral takes it (see
//   mistralBody below): Mistral turns an unknown message field away as 422
//   extra_forbidden.
// - Usage is the public billing read the CLI does:
//   GET api.mistral.ai/v1/billing/subscription (plan name, pay-as-you-go) and
//   GET api.mistral.ai/v1/billing/budget (vibe_budget: usage_percentage,
//   initial_budget, reset_at); the plan also comes from console's
//   /api/vibe/whoami.
//
// The provider id is "mistral-vibe", kept apart from the "mistral" preset
// (api.mistral.ai with the user's own API key).
import { createHash, randomBytes } from "node:crypto"

const ID = "mistral-vibe"

// bases are functions so tests can point them at a stand-in with the
// MISTRAL_VIBE_API_BASE / MISTRAL_VIBE_CONSOLE_API environment variables
const apiBase = () => (process.env.MISTRAL_VIBE_API_BASE || "https://api.mistral.ai/v1").replace(/\/+$/, "")
const consoleApi = () => (process.env.MISTRAL_VIBE_CONSOLE_API || "https://console.mistral.ai/api").replace(/\/+$/, "")

const POLL_EVERY_MS = 1500
const SIGN_IN_TTL_MS = 10 * 60 * 1000
const DEFAULT_LIMIT = { context: 262_144, output: 65_536 }

// Prices from https://docs.mistral.ai/inference/pricing (USD per 1M tokens,
// standard tier, checked 2026-11-06), for the current LLM models only. The
// keys are the ids the docs and /v1/models agree on, plus Large 4's billing
// name; an alias is priced through its own billing_model_name, so it follows
// the model behind it rather than a price kept for the alias. Older
// generations and the speech, OCR and embedding models keep models.dev's
// price when it has one.
const DOCS_PRICES = {
  "mistral-large-4": { input: 0.7, output: 2.1, cache_read: 0.07 },
  "mistral-large-4-0": { input: 0.7, output: 2.1, cache_read: 0.07 },
  "mistral-large-4-0-a": { input: 0.7, output: 2.1, cache_read: 0.07 },
  "mistral-small-2603": { input: 0.15, output: 0.6, cache_read: 0.015 },
  "ministral-14b-2512": { input: 0.2, output: 0.2, cache_read: 0.02 },
  "ministral-8b-2512": { input: 0.15, output: 0.15, cache_read: 0.015 },
  "ministral-3b-2512": { input: 0.1, output: 0.1, cache_read: 0.01 },
  "codestral-2508": { input: 0.3, output: 0.9, cache_read: 0.03 },
  "zai-glm-5-3": { input: 1.4, output: 4.4, cache_read: 0.14 },
  "zai-glm-5-3-flash": { input: 0.15, output: 0.5, cache_read: 0.03 },
  "deepseek-v4-1-flash-1017": { input: 0.3, output: 1.2, cache_read: 0.007 },
  // mistral-large-latest is deliberately absent: the vendor still bills it as
  // mistral-large-2512 (Large 3), so models.dev's price for it is the right one.
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
  })

const keyOf = (auth) => (auth?.type === "api" || auth?.key ? auth.key : auth?.access) || ""

// ---- the browser sign-in (vibe's setup/auth/http_browser_sign_in_gateway) ----

const newVerifier = () => randomBytes(48).toString("base64url")
const challengeOf = (verifier) => createHash("sha256").update(verifier).digest("base64url")

async function startSignIn(signal) {
  const code_verifier = newVerifier()
  const res = await fetch(`${consoleApi()}/vibe/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code_challenge: challengeOf(code_verifier), code_challenge_method: "S256" }),
    signal,
  })
  if (!res.ok) throw new Error(`Mistral sign-in could not start (${res.status})`)
  const d = await res.json()
  if (!d?.process_id || !d?.sign_in_url || !d?.poll_url) throw new Error("Mistral sign-in answered an unexpected payload")
  return { process_id: d.process_id, sign_in_url: d.sign_in_url, poll_url: d.poll_url, expires_at: d.expires_at, code_verifier }
}

async function pollSignIn(pollUrl, signal) {
  const res = await fetch(pollUrl, { signal })
  if (res.status === 410) return { status: "expired" }
  if (!res.ok) throw new Error(`Mistral sign-in poll answered ${res.status}`)
  return await res.json()
}

async function exchangeSignIn(processId, exchangeToken, codeVerifier, signal) {
  const res = await fetch(`${consoleApi()}/vibe/sign-in/${encodeURIComponent(processId)}/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ exchange_token: exchangeToken, code_verifier: codeVerifier }),
    signal,
  })
  if (!res.ok) throw new Error(`Mistral sign-in exchange failed (${res.status})`)
  const d = await res.json()
  if (!d?.api_key) throw new Error("Mistral sign-in exchange returned no API key")
  return d.api_key
}

// whoami names the plan behind a key (console.mistral.ai/api/vibe/whoami)
async function whoami(key) {
  const res = await fetch(`${consoleApi()}/vibe/whoami`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) return null
  return await res.json().catch(() => null)
}

// ---- models: /v1/models, limits filled from models.dev when it knows them ----

let devModels = null
async function modelsDev() {
  if (devModels) return devModels
  try {
    const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(5000) })
    const j = await res.json()
    devModels = j?.mistral?.models ?? {}
  } catch {
    devModels = {}
  }
  return devModels
}

// priceOf is a model's list price as OpenCode and magpie take it: USD per
// 1M tokens, with the cache read and write beside input and output. docs
// first, then models.dev, and undefined when nothing prices it rather than
// a made-up zero.
function priceOf(m, dev) {
  const caps = m?.capabilities ?? {}
  const billing = typeof m?.billing_model_name === "string" ? m.billing_model_name : ""
  const aliases = Array.isArray(m?.aliases) ? m.aliases : []
  const names = [billing, ...aliases, m?.id].filter((id) => typeof id === "string" && id)
  const stated = names.map((id) => DOCS_PRICES[id]).find(Boolean)
  // a speech or non-chat model's models.dev price may be per minute, page or
  // character rather than per token, so only chat models without audio take it
  const audio =
    caps.audio === true || caps.audio_transcription === true || caps.audio_transcription_realtime === true || caps.audio_speech === true
  const chat = caps.completion_chat ?? true
  const p = stated ?? (chat && !audio ? names.map((id) => dev?.[id]?.cost).find(Boolean) : undefined)
  if (!p || typeof p !== "object") return undefined
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0)
  const cache = p.cache && typeof p.cache === "object" ? p.cache : {}
  return {
    input: n(p.input),
    output: n(p.output),
    cache: { read: n(p.cache_read ?? cache.read), write: n(p.cache_write ?? cache.write) },
  }
}

async function listModels(key) {
  const res = await fetch(`${apiBase()}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) return null
  const j = await res.json().catch(() => null)
  const dev = await modelsDev()
  const out = {}
  for (const m of j?.data ?? []) {
    if (!m?.id || typeof m.id !== "string") continue
    const billing = typeof m.billing_model_name === "string" ? m.billing_model_name : ""
    const aliases = Array.isArray(m.aliases) ? m.aliases : []
    const d = [billing, ...aliases, m.id].map((id) => dev[id]).find(Boolean) ?? {}
    const caps = m.capabilities ?? {}
    const image = caps.vision ?? d.attachment ?? false
    const reasoning = caps.reasoning ?? d.reasoning ?? false
    const toolcall = caps.function_calling ?? d.tool_call ?? true
    const chat = caps.completion_chat ?? true
    const context =
      Number(m.max_context_length) > 0 ? Number(m.max_context_length) : d.limit?.context ?? DEFAULT_LIMIT.context
    const inputs = {
      text: caps.ocr !== true,
      image: image === true,
      audio: caps.audio === true || caps.audio_transcription === true || caps.audio_transcription_realtime === true,
      video: false,
      pdf: Array.isArray(d.modalities?.input) && d.modalities.input.includes("pdf"),
    }
    const outputs = { text: chat === true, image: false, audio: caps.audio_speech === true, video: false, pdf: false }
    const modalities = (kinds) => Object.keys(kinds).filter((k) => kinds[k])
    const model = {
      name: d.name ?? m.id,
      limit: {
        context,
        output: d.limit?.output ?? DEFAULT_LIMIT.output,
      },
      tool_call: toolcall,
      attachment: image,
      reasoning,
      temperature: chat,
      // OpenCode 1.x's model shape, so magpie and 2.x see what the model
      // takes and gives (and leave a TTS or an embedding out of chat lists)
      modalities: { input: modalities(inputs), output: modalities(outputs) },
      capabilities: {
        temperature: chat,
        reasoning,
        attachment: image,
        toolcall,
        input: inputs,
        output: outputs,
        interleaved: false,
      },
    }
    const cost = priceOf(m, dev)
    if (cost) model.cost = cost
    out[m.id] = model
  }
  return out
}

// ---- usage: the billing reads (vibe's app_server/_billing.py) ----

async function readUsage(key) {
  const headers = { Authorization: `Bearer ${key}` }
  const ask = async (url) => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  }
  const [subscription, budget, who] = await Promise.all([
    ask(`${apiBase()}/billing/subscription`),
    ask(`${apiBase()}/billing/budget`),
    whoami(key),
  ])
  const plan = subscription?.plan_name || who?.plan_name || undefined
  const vb = budget?.vibe_budget
  const windows = []
  if (vb && typeof vb.usage_percentage === "number") {
    const resetsAt = vb.reset_at ? Date.parse(vb.reset_at) : NaN
    const span = Number.isFinite(resetsAt) ? Math.max(3600, Math.floor((resetsAt - Date.now()) / 1000)) : 30 * 86400
    windows.push({
      name: "Monthly Vibe Code",
      used: vb.usage_percentage,
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
      span,
    })
  }
  return { plan, windows, payg: subscription?.vibe_payg_enabled ?? vb?.payg_enabled ?? undefined }
}

// ---- an earlier turn's thinking, in the shape Mistral takes it ----

// api.mistral.ai reads each chat message strictly: a field it doesn't know
// turns the whole request away as 422 "Extra inputs are not permitted"
// (extra_forbidden, loc ["body","messages",2,"assistant",
// "reasoning_content"]). An earlier assistant turn's thinking comes back
// from most clients in one of these fields — reasoning_content (OpenCode,
// pi, Claude Code through a gateway), reasoning (OpenRouter's) and
// reasoning_details (OpenRouter's structured one) — so a conversation with
// a thinking turn in it never gets through. Mistral returns a thinking turn
// as a typed content part and takes it back that way, so the thinking goes
// there, ahead of the turn's own text, as magpie's own Mistral handling
// gives it (#494).
const THINKING_FIELDS = ["reasoning_content", "reasoning", "reasoning_details"]

// thinkingText is the thinking a message carries in THINKING_FIELDS.
function thinkingText(m) {
  for (const f of THINKING_FIELDS.slice(0, 2)) {
    const v = m[f]
    if (typeof v === "string" && v !== "") return v
  }
  const details = m.reasoning_details
  if (!Array.isArray(details)) return ""
  let out = ""
  for (const d of details) {
    if (!d || typeof d !== "object") continue
    if (typeof d.text === "string" && d.text !== "") out += d.text
    else if (typeof d.summary === "string") out += d.summary
  }
  return out
}

// asMistralMessage puts one message's thinking where Mistral takes it and
// says whether it changed anything. A message with no thinking of its own
// keeps its bytes. A prefill (prefix) keeps its content as it is: its text
// is what goes on, so the thinking is only dropped there.
function asMistralMessage(m) {
  if (!THINKING_FIELDS.some((f) => f in m)) return false
  const think = thinkingText(m)
  for (const f of THINKING_FIELDS) delete m[f]
  if (think === "" || m.role !== "assistant" || m.prefix === true) return true
  const part = { type: "thinking", thinking: [{ type: "text", text: think }] }
  const c = m.content
  if (typeof c === "string") m.content = c === "" ? [part] : [part, { type: "text", text: c }]
  else if (Array.isArray(c)) m.content = [part, ...c]
  else m.content = [part]
  return true
}

// mistralBody is a chat request's body with every message's thinking in the
// shape Mistral takes, and without the fields it turns away. A body with no
// such field comes back as it was, byte for byte, and so does one that isn't
// a chat request's JSON.
function mistralBody(body) {
  if (typeof body !== "string" || !body.includes("reasoning")) return body
  let q
  try {
    q = JSON.parse(body)
  } catch {
    return body
  }
  if (!q || typeof q !== "object" || !Array.isArray(q.messages)) return body
  let changed = false
  for (const m of q.messages) if (m && typeof m === "object" && asMistralMessage(m)) changed = true
  return changed ? JSON.stringify(q) : body
}

// ---- the plugin ----

export const MistralVibeAuthPlugin = async ({ client } = {}) => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[ID] ??= {
      name: "Mistral Vibe Code",
      npm: "@ai-sdk/openai-compatible",
      api: apiBase(),
      models: {},
    }
  },
  auth: {
    provider: ID,
    usage: async (getAuth) => {
      const key = keyOf(await getAuth())
      if (!key) return { error: "Not signed in", windows: [] }
      try {
        const u = await readUsage(key)
        return { plan: u.plan, windows: u.windows }
      } catch (e) {
        return { error: `Mistral billing read failed: ${e?.message ?? e}`, windows: [] }
      }
    },
    loader: async (getAuth) => {
      const auth = await getAuth()
      const key = keyOf(auth)
      if (!key) return {}
      return {
        baseURL: apiBase(),
        apiKey: "mistral-vibe", // the engine's placeholder; the fetch below signs
        async fetch(input, init = {}) {
          const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
          headers.set("Authorization", `Bearer ${key}`)
          const body = mistralBody(init.body)
          if (body !== init.body) {
            // the length the engine counted is not the one sent
            headers.delete("content-length")
            return fetch(input, { ...init, headers, body })
          }
          return fetch(input, { ...init, headers })
        },
      }
    },
    methods: [
      {
        type: "oauth",
        label: "Sign in with Mistral (browser)",
        authorize: async (_inputs, { signal } = {}) => {
          const p = await startSignIn(signal)
          return {
            url: p.sign_in_url,
            instructions: "Sign in to your Mistral account on the page that opens. The sign-in finishes here by itself.",
            method: "auto",
            callback: async (_code, { signal: cbSignal } = {}) => {
              const s = cbSignal ?? signal
              const deadline = (Date.parse(p.expires_at) || Date.now() + SIGN_IN_TTL_MS)
              for (;;) {
                let r
                try {
                  r = await pollSignIn(p.poll_url, s)
                } catch (e) {
                  if (Date.now() > deadline) return { type: "failed", error: `Sign-in poll failed: ${e?.message ?? e}` }
                  await sleep(POLL_EVERY_MS, s)
                  continue
                }
                if (r?.status === "completed" && r.exchange_token) {
                  try {
                    const key = await exchangeSignIn(p.process_id, r.exchange_token, p.code_verifier, s)
                    const who = await whoami(key).catch(() => null)
                    const out = { type: "success", key, metadata: { plan: who?.plan_name, vibeEntitlement: who?.has_paid_vibe_entitlement } }
                    if (who?.customer_id != null) out.accountId = String(who.customer_id)
                    return out
                  } catch (e) {
                    return { type: "failed", error: `Sign-in exchange failed: ${e?.message ?? e}` }
                  }
                }
                if (r?.status === "expired") return { type: "failed", error: "The sign-in expired; start it again" }
                if (r?.status === "denied") return { type: "failed", error: r.message || "The sign-in was denied" }
                if (r?.status === "error") return { type: "failed", error: r.message || "The sign-in failed" }
                if (Date.now() > deadline) return { type: "failed", error: "The sign-in timed out; start it again" }
                await sleep(POLL_EVERY_MS, s)
              }
            },
          }
        },
      },
      {
        type: "api",
        label: "Vibe Code API key",
        placeholder: "key made in console.mistral.ai under Code > Vibe Code CLI",
      },
    ],
  },
  provider: {
    id: ID,
    async models(provider, { auth } = {}) {
      const key = keyOf(auth)
      if (!key) return provider?.models ?? {}
      const got = await listModels(key).catch(() => null)
      return got && Object.keys(got).length ? got : (provider?.models ?? {})
    },
  },
})

// for tests
export const _internal = { startSignIn, pollSignIn, exchangeSignIn, whoami, listModels, readUsage, keyOf, priceOf, DOCS_PRICES, mistralBody, THINKING_FIELDS, ID, apiBase, consoleApi }
