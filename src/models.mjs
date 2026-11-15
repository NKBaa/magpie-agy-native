export const PROVIDER_ID = "agy-native"
export const DEFAULT_MODEL_ID = "agy-default"
export const FALLBACK_MODEL_ID = DEFAULT_MODEL_ID

const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "none"])
const EFFORT_RE = /^(.*)-(minimal|low|medium|high|xhigh|max|none)$/i

function asModel(id, name, efforts = [], source = null) {
  const variants = Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]))
  return {
    id,
    name: name || id,
    family: "antigravity",
    apiId: id,
    npm: "@ai-sdk/openai-compatible",
    url: "http://agy-native.invalid/v1",
    reasoning: efforts.length > 0,
    tool_call: true,
    temperature: true,
    image: true,
    context: 1048576,
    input: 1048576,
    output: 65535,
    limit: { context: 1048576, output: 65535 },
    inputs: ["text", "image"],
    outputs: ["text"],
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    ...(efforts.length ? { efforts, variants } : {}),
    ...(source ? { source } : {}),
  }
}

export function fallbackModels() {
  return {
    [DEFAULT_MODEL_ID]: asModel(DEFAULT_MODEL_ID, "agy default (auto)"),
  }
}

export function groupModels(entries) {
  const groups = new Map()
  for (const raw of Array.isArray(entries) ? entries : []) {
    const entry = typeof raw === "string" ? { modelId: raw, name: raw } : raw
    if (!entry || typeof entry.modelId !== "string" || !entry.modelId) continue
    const match = EFFORT_RE.exec(entry.modelId)
    const effort = match && EFFORTS.has(match[2].toLowerCase()) ? match[2].toLowerCase() : ""
    const base = match && effort ? match[1] : entry.modelId
    const group = groups.get(base) || []
    group.push({ ...entry, effort })
    groups.set(base, group)
  }

  const result = {}
  for (const [id, group] of groups) {
    const efforts = [...new Set(group.map((item) => item.effort).filter(Boolean))]
    if (efforts.length >= 2) {
      const named = group.find((item) => item.name && !EFFORT_RE.test(item.name))
      const fallbackName = group[0].name || id
      result[id] = asModel(id, named?.name || fallbackName.replace(/\s*\((?:minimal|low|medium|high|xhigh|max|none)\)$/i, ""), efforts)
    } else {
      const item = group[0]
      result[item.modelId] = asModel(item.modelId, item.name || item.modelId)
    }
  }
  return result
}

export function requestedEffort(body) {
  const values = [
    body?.reasoning_effort,
    body?.reasoningEffort,
    body?.reasoning?.effort,
    body?.variant,
    body?.providerOptions?.openai?.reasoningEffort,
    body?.providerOptions?.["agy-native"]?.reasoningEffort,
  ]
  for (const value of values) {
    if (typeof value === "string" && EFFORTS.has(value.toLowerCase())) return value.toLowerCase()
  }
  return ""
}

function lastPathSegment(value) {
  return String(value || "").split(/[\\/]/).filter(Boolean).at(-1) || ""
}

export function chooseWireModel(requested, effort, availableModels, currentModelId) {
  const asked = lastPathSegment(requested || DEFAULT_MODEL_ID)
  const available = [...new Set((availableModels || []).filter((item) => typeof item === "string" && item))]
  if (!asked || asked === DEFAULT_MODEL_ID) return currentModelId || available[0] || null
  if (available.includes(asked)) return asked

  const candidates = available.filter((id) => id.startsWith(`${asked}-`))
  if (!candidates.length) {
    const suggestions = available.slice(0, 12).join(", ")
    throw new Error(`agy ACP does not advertise model "${asked}"${suggestions ? `; available: ${suggestions}` : ""}`)
  }
  const wanted = effort || "medium"
  return candidates.find((id) => id.toLowerCase().endsWith(`-${wanted}`)) || candidates[0]
}

export function modelName(entry) {
  return entry?.name || entry?.modelId || entry
}

export const _modelInternals = { asModel, EFFORTS, EFFORT_RE, lastPathSegment }

