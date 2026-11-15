const DEFAULT_MAX_PROMPT_BYTES = 180_000
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024

function byteLength(text) {
  return Buffer.byteLength(String(text || ""), "utf8")
}

function truncateUtf8(text, maxBytes, from = "end") {
  const value = String(text || "")
  if (byteLength(value) <= maxBytes) return value
  const buffer = Buffer.from(value)
  if (maxBytes <= 0) return ""
  if (from === "start") return buffer.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/g, "")
  return buffer.subarray(buffer.length - maxBytes).toString("utf8").replace(/^\uFFFD+/g, "")
}

export async function requestBodyOf(input, init = {}) {
  let body = init?.body
  if (body == null && input && typeof input === "object" && typeof input.text === "function") {
    body = await input.clone().text()
  }
  if (body == null) throw new Error("agy native request has no JSON body")
  if (typeof body === "string") return JSON.parse(body)
  if (body instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(body))
  if (body instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(new Uint8Array(body)))
  throw new Error("agy native request body must be JSON text or bytes")
}

function partText(part) {
  if (typeof part === "string") return part
  if (!part || typeof part !== "object") return ""
  if (["text", "input_text", "output_text"].includes(part.type)) return part.text || part.content || ""
  if (part.type === "refusal") return part.refusal || ""
  if (["image_url", "input_image", "image"].includes(part.type)) return "[image attached]"
  if (part.type === "file" || part.type === "input_file") {
    return `[file${part.filename ? `: ${part.filename}` : ""}]`
  }
  if (part.type === "tool_result") return contentText(part.content)
  return part.text || part.content || ""
}

export function contentText(content) {
  if (typeof content === "string") return content
  if (content == null) return ""
  if (Array.isArray(content)) return content.map(partText).filter(Boolean).join("\n")
  return partText(content)
}

function formatToolCalls(calls) {
  if (!Array.isArray(calls) || calls.length === 0) return ""
  return calls.map((call) => {
    const name = call?.function?.name || call?.name || "tool"
    const args = call?.function?.arguments ?? call?.arguments ?? ""
    return `[tool call: ${name}] ${typeof args === "string" ? args : JSON.stringify(args)}`
  }).join("\n")
}

function formatMessage(message) {
  const role = String(message?.role || "user")
  const text = contentText(message?.content)
  const calls = formatToolCalls(message?.tool_calls)
  const name = message?.name ? ` (${message.name})` : ""
  const body = [text, calls].filter(Boolean).join("\n")
  return `${role.toUpperCase()}${name}:\n${body}`
}

function maxPromptBytes(env = process.env) {
  const configured = Number(env.MAGPIE_AGY_PROMPT_LIMIT_BYTES)
  return Number.isSafeInteger(configured) && configured >= 4096 ? configured : DEFAULT_MAX_PROMPT_BYTES
}

export function buildConversation(messages, limit = maxPromptBytes()) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error("agy native request requires a non-empty messages array")
  const systems = []
  const turns = []
  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    if (["system", "developer"].includes(message.role)) systems.push(contentText(message.content))
    else turns.push(formatMessage(message))
  }

  const header = [
    "You are running through the official Google Antigravity agy ACP runtime.",
    "Follow the conversation below. Use your native agent capabilities when the task requires workspace actions.",
  ].join("\n")
  const systemBlock = systems.filter(Boolean).join("\n\n")
  const systemSection = systemBlock ? `\n\nSYSTEM INSTRUCTIONS:\n${systemBlock}` : ""
  const fixedBytes = byteLength(header) + byteLength(systemSection) + byteLength("\n\nCONVERSATION:\n")
  if (fixedBytes >= limit) {
    const shortened = truncateUtf8(systemBlock, Math.max(0, limit - byteLength(header) - 32), "start")
    return {
      text: `${header}${shortened ? `\n\nSYSTEM INSTRUCTIONS (truncated):\n${shortened}` : ""}`,
      truncated: true,
    }
  }

  let budget = limit - fixedBytes
  const included = []
  let omitted = 0
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const block = turns[index]
    const cost = byteLength(block) + 2
    if (cost <= budget) {
      included.unshift(block)
      budget -= cost
      continue
    }
    omitted = index + 1
    if (included.length === 0 && budget > 128) {
      included.unshift(truncateUtf8(block, budget - 32, "end"))
      omitted = index
    }
    break
  }

  const truncationNotice = omitted > 0 ? `[${omitted} older conversation message(s) truncated by the adapter]\n\n` : ""
  return {
    text: `${header}${systemSection}\n\nCONVERSATION:\n${truncationNotice}${included.join("\n\n")}`,
    truncated: omitted > 0,
  }
}

function imageUrlOf(part) {
  if (!part || typeof part !== "object") return null
  if (part.type === "image_url") {
    if (typeof part.image_url === "string") return part.image_url
    if (part.image_url && typeof part.image_url.url === "string") return part.image_url.url
  }
  if (part.type === "input_image" && typeof part.image_url === "string") return part.image_url
  if (part.type === "image" && typeof part.url === "string") return part.url
  return null
}

function parseDataUrl(url) {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i.exec(url)
  if (!match) return null
  const mimeType = match[1] || "application/octet-stream"
  if (match[2]) return { mimeType, data: match[3].replace(/\s+/g, "") }
  return { mimeType, data: Buffer.from(decodeURIComponent(match[3]), "utf8").toString("base64") }
}

async function remoteImage(url, signal, limit) {
  const timeout = AbortSignal.timeout(15_000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  const response = await fetch(url, { signal: combined })
  if (!response.ok) throw new Error(`failed to fetch image (${response.status})`)
  const size = Number(response.headers.get("content-length") || 0)
  if (size > limit) throw new Error(`image is larger than ${limit} bytes`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > limit) throw new Error(`image is larger than ${limit} bytes`)
  const mimeType = (response.headers.get("content-type") || "image/png").split(";")[0]
  return { mimeType, data: bytes.toString("base64") }
}

async function imageBlock(url, signal, limit) {
  if (typeof url !== "string" || !url) return null
  const parsed = parseDataUrl(url)
  if (parsed) {
    if (Buffer.byteLength(parsed.data, "base64") > limit) throw new Error(`image is larger than ${limit} bytes`)
    return { type: "image", mimeType: parsed.mimeType, data: parsed.data }
  }
  if (/^https?:\/\//i.test(url)) return { type: "image", ...(await remoteImage(url, signal, limit)) }
  return null
}

async function lastUserImages(messages, signal, env = process.env) {
  const lastUser = [...messages].reverse().find((message) => message?.role === "user")
  if (!lastUser || !Array.isArray(lastUser.content)) return []
  const limit = Number(env.MAGPIE_AGY_MAX_IMAGE_BYTES) || DEFAULT_MAX_IMAGE_BYTES
  const blocks = []
  for (const part of lastUser.content) {
    const block = await imageBlock(imageUrlOf(part), signal, limit)
    if (block) blocks.push(block)
  }
  return blocks
}

export async function buildPrompt(messages, { signal, env = process.env } = {}) {
  const conversation = buildConversation(messages, maxPromptBytes(env))
  const images = await lastUserImages(messages, signal, env)
  return {
    text: conversation.text,
    truncated: conversation.truncated,
    images,
    parts: [{ type: "text", text: conversation.text }, ...images],
  }
}

export const _promptInternals = {
  byteLength,
  truncateUtf8,
  formatMessage,
  imageUrlOf,
  parseDataUrl,
  maxPromptBytes,
}

