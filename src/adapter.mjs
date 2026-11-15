import { randomUUID } from "node:crypto"
import { AcpClient } from "./acp.mjs"
import { chooseWireModel, requestedEffort } from "./models.mjs"
import { buildPrompt, requestBodyOf } from "./prompt.mjs"
import { resolveRuntime } from "./runtime.mjs"

const encoder = new TextEncoder()

function jsonResponse(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  })
}

const ERROR_CODES = Object.freeze({
  signInRequired: "sign_in_required",
  sessionExpired: "session_expired",
  invalidRequest: "invalid_request",
  modelNotFound: "model_not_found",
  rateLimited: "rate_limited",
  upstreamUnavailable: "upstream_unavailable",
  upstreamTimeout: "upstream_timeout",
  upstreamError: "upstream_error",
  internalError: "internal_error",
  notImplemented: "not_implemented",
})

function errorType(status) {
  if (status === 401) return "authentication_error"
  if (status === 404) return "invalid_request_error"
  if (status === 429) return "rate_limit_error"
  return "agy_native_error"
}

export function classifyError(error) {
  const message = String(error?.message || error)
  if (error?.name === "AbortError") {
    return { status: 499, code: ERROR_CODES.upstreamError, message }
  }
  if (/timed out|timeout/i.test(message)) {
    return { status: 504, code: ERROR_CODES.upstreamTimeout, message }
  }
  if (/not signed|sign.?in|login required|credential|no auth/i.test(message)) {
    return { status: 401, code: ERROR_CODES.signInRequired, message }
  }
  if (/session expired|authentication|unauthori|invalid.*token|expired/i.test(message)) {
    return { status: 401, code: ERROR_CODES.sessionExpired, message }
  }
  if (/rate limit|quota|resource exhausted|429|too many requests/i.test(message)) {
    return { status: 429, code: ERROR_CODES.rateLimited, message }
  }
  if (/does not advertise model|unknown model|model.*not found/i.test(message)) {
    return { status: 404, code: ERROR_CODES.modelNotFound, message }
  }
  if (/no sessionId|has not started|already started|did not contain sessionId/i.test(message)) {
    return { status: 502, code: ERROR_CODES.internalError, message }
  }
  if (/not found|ENOENT|failed to start agy|official Antigravity CLI not found/i.test(message)) {
    return { status: 502, code: ERROR_CODES.internalError, message }
  }
  if (/invalid request|bad request|messages array|requires a non-empty|unsupported content/i.test(message)) {
    return { status: 400, code: ERROR_CODES.invalidRequest, message }
  }
  if (/exited unexpectedly|ACP .*failed|upstream|server error|5\d\d/i.test(message)) {
    return { status: 503, code: ERROR_CODES.upstreamUnavailable, message }
  }
  return { status: 502, code: ERROR_CODES.upstreamError, message }
}

export function errorStatus(error) {
  return classifyError(error).status
}

export function errorResponse(error, _statusOverride, _codeOverride) {
  const classified = classifyError(error)
  const headers = classified.status === 401 && classified.code === ERROR_CODES.sessionExpired
    ? { "x-magpie-sign-in": "kept" }
    : {}
  return jsonResponse({
    error: {
      message: classified.message,
      type: errorType(classified.status),
      param: null,
      code: classified.code,
      status: classified.status,
    },
  }, classified.status, headers)
}

function mapStopReason(reason) {
  if (reason === "max_tokens") return "length"
  if (reason === "refusal") return "content_filter"
  if (reason === "cancelled") return "stop"
  return "stop"
}

function token(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0
}

export function translateAcpUsage(raw) {
  if (!raw || typeof raw !== "object") return null
  const input = token(raw.inputTokens ?? raw.input_tokens ?? raw.promptTokens ?? raw.prompt_tokens)
  const output = token(raw.outputTokens ?? raw.output_tokens ?? raw.completionTokens ?? raw.completion_tokens)
  const cached = token(raw.cachedReadTokens ?? raw.cached_read_tokens ?? raw.cacheReadTokens ?? raw.cache_read_input_tokens)
  const reasoning = token(raw.thoughtTokens ?? raw.thought_tokens ?? raw.reasoningTokens ?? raw.reasoning_tokens)
  const total = token(raw.totalTokens ?? raw.total_tokens) || input + output
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: total,
    ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    ...(reasoning ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
  }
}

function textFromContent(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part
      if (part?.type === "text" && typeof part.text === "string") return part.text
      return ""
    }).join("")
  }
  return typeof content?.text === "string" ? content.text : ""
}

function updateText(update) {
  if (!update || typeof update !== "object") return ""
  return textFromContent(update.content)
}

async function runAcp({ body, prompt, signal, env, cwd, permissionPolicy, onReady, onText, onThought }) {
  const runtime = resolveRuntime(env)
  const client = new AcpClient({
    runtime,
    env,
    permissionPolicy,
    debug: env.MAGPIE_AGY_DEBUG === "1",
    onUpdate(update) {
      const kind = update?.sessionUpdate
      if (kind === "agent_message_chunk") {
        const text = updateText(update)
        if (text) onText?.(text)
      } else if (kind === "agent_thought_chunk") {
        const text = updateText(update)
        if (text) onThought?.(text)
      }
    },
  })

  try {
    const session = await client.start({ cwd, signal })
    const available = (session?.models?.availableModels || [])
      .map((entry) => typeof entry === "string" ? entry : entry?.modelId)
      .filter(Boolean)
    const wireModel = chooseWireModel(body.model, requestedEffort(body), available, session?.models?.currentModelId)
    if (wireModel) await client.setModel(wireModel)
    if (env.MAGPIE_AGY_DEBUG === "1") {
      console.error(`[agy-native] model ${body.model || "(default)"} -> ${wireModel || "(server default)"}`)
    }
    onReady?.({ client, wireModel, session, prompt })
    const result = await client.prompt(prompt.parts)
    return {
      usage: translateAcpUsage(result?.usage),
      stopReason: result?.stopReason || "end_turn",
      wireModel,
    }
  } finally {
    client.close()
  }
}

function completionObject({ id, created, model, text, thought, stopReason, usage }) {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    system_fingerprint: "agy-native-acp",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text,
        ...(thought ? { reasoning_content: thought } : {}),
      },
      finish_reason: mapStopReason(stopReason),
    }],
    ...(usage ? { usage } : {}),
  }
}

async function complete({ body, prompt, init, options }) {
  let text = ""
  let thought = ""
  const executed = await runAcp({
    body,
    prompt,
    signal: init?.signal,
    env: options.env,
    cwd: options.cwd,
    permissionPolicy: options.permissionPolicy,
    onText: (chunk) => { text += chunk },
    onThought: (chunk) => { thought += chunk },
  })
  return completionObject({
    id: `chatcmpl-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    model: body.model || executed.wireModel || "agy-default",
    text,
    thought,
    stopReason: executed.stopReason,
    usage: executed.usage,
  })
}

function chunkPayload({ id, created, model, delta, finishReason = null, usage = undefined }) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    system_fingerprint: "agy-native-acp",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage !== undefined ? { usage } : {}),
  }
}

async function streamResponse({ body, prompt, init, options }) {
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const model = body.model || "agy-default"
  let controller
  let readyResolved = false
  let readyRejected = false
  let resolveReady
  let rejectReady
  let finished = false
  let text = ""
  let thought = ""
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const stream = new ReadableStream({
    start(value) {
      controller = value
    },
    cancel() {
      finished = true
      resolveReady?.()
      options.onCancel?.()
    },
  })

  const send = (value) => {
    if (!finished) controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
  }
  const close = () => {
    if (!finished) {
      finished = true
      controller.close()
    }
  }

  ;(async () => {
    try {
      send(chunkPayload({ id, created, model, delta: { role: "assistant" } }))
      const executed = await runAcp({
        body,
        prompt,
        signal: init?.signal,
        env: options.env,
        cwd: options.cwd,
        permissionPolicy: options.permissionPolicy,
        onReady: ({ client }) => {
          options.onClient?.(client)
          readyResolved = true
          resolveReady()
        },
        onText: (chunk) => {
          text += chunk
          send(chunkPayload({ id, created, model, delta: { content: chunk } }))
        },
        onThought: (chunk) => {
          thought += chunk
          send(chunkPayload({ id, created, model, delta: { reasoning_content: chunk, reasoning: chunk } }))
        },
      })
      send(chunkPayload({ id, created, model, delta: {}, finishReason: mapStopReason(executed.stopReason) }))
      if (executed.usage) {
        send({ id, object: "chat.completion.chunk", created, model, system_fingerprint: "agy-native-acp", choices: [], usage: executed.usage })
      }
      if (!finished) controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      close()
    } catch (error) {
      if (!readyResolved) {
        readyRejected = true
        try { controller.close() } catch {}
        rejectReady(error)
        return
      }
      const classified = classifyError(error)
      send({
        error: {
          message: classified.message,
          type: errorType(classified.status),
          param: null,
          code: classified.code,
          status: classified.status,
        },
      })
      if (!finished) controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      close()
    }
  })()

  try {
    await ready
  } catch (error) {
    return errorResponse(error, undefined, "upstream_error")
  }
  if (readyRejected) return errorResponse(new Error("agy native stream failed before initialization"), undefined, "upstream_error")
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  })
}

export async function createChatResponse(input, init = {}, options = {}) {
  try {
    const env = options.env || process.env
    const url = typeof input === "string" ? input : input?.url || ""
    const method = String(init?.method || input?.method || "POST").toUpperCase()
    if (method === "GET" && /\/models\/?$/.test(url)) {
      return jsonResponse({
        object: "list",
        data: [{ id: "agy-default", object: "model", created: 0, owned_by: "antigravity" }],
      })
    }
    if (method !== "POST") {
      return jsonResponse({
        error: { message: "method not allowed", type: "invalid_request_error", param: null, code: "not_implemented", status: 501 },
      }, 501)
    }

    const signal = init?.signal || input?.signal
    const body = await requestBodyOf(input, init)
    const prompt = await buildPrompt(body.messages, { signal, env })
    const cwd = body.cwd || env.MAGPIE_AGY_CWD || options.cwd || process.cwd()
    const permissionPolicy = options.permissionPolicy === "allow" ? "allow" : "deny"
    if (body.stream === true) {
      let client = null
      return await streamResponse({
        body,
        prompt,
        init: { ...init, signal },
        options: {
          env,
          cwd,
          permissionPolicy,
          onClient(value) { client = value },
          onCancel() { client?.cancelTurn(); client?.close(new DOMException("stream cancelled", "AbortError")) },
        },
      })
    }
    const completion = await complete({
      body,
      prompt,
      init,
      options: { env, cwd, permissionPolicy },
    })
    return jsonResponse(completion)
  } catch (error) {
    return errorResponse(error, undefined, "upstream_error")
  }
}

export const _adapterInternals = { mapStopReason, errorStatus, classifyError, textFromContent, runAcp }








