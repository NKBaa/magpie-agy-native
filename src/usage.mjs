import { spawn } from "node:child_process"
import { commandSpec, resolveRuntime, runtimeEnvironment } from "./runtime.mjs"

const USAGE_TIMEOUT_MS = 30_000
const SPANS = { "5h": 5 * 60 * 60, weekly: 7 * 24 * 60 * 60 }

function finitePercent(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null
}

function resetFields(bucket) {
  const value = bucket?.reset_time || bucket?.resetTime || bucket?.resetsAt
  if (typeof value === "string" && value && !Number.isNaN(Date.parse(value))) {
    return { resetsAt: new Date(value).toISOString() }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 10_000_000_000 ? value * 1000 : value
    return { resetsAt: new Date(ms).toISOString() }
  }
  return {}
}

function bucketWindow(name, bucket) {
  const fraction = bucket?.remaining_fraction ?? bucket?.remainingFraction
  const remainingRaw = bucket?.remaining
  let inferredUsed = null
  if (fraction != null && Number.isFinite(Number(fraction))) {
    inferredUsed = (1 - Number(fraction)) * 100
  } else if (remainingRaw != null && Number.isFinite(Number(remainingRaw))) {
    const remaining = Number(remainingRaw)
    inferredUsed = remaining <= 1 ? (1 - remaining) * 100 : 100 - remaining
  }

  const usedFraction = bucket?.used_fraction ?? bucket?.usedFraction
  const usedRaw = bucket?.used
  let usedValue = inferredUsed
  if (usedFraction != null && Number.isFinite(Number(usedFraction))) {
    usedValue = Number(usedFraction) * 100
  } else if (usedRaw != null && Number.isFinite(Number(usedRaw))) {
    usedValue = Number(usedRaw)
  }

  const used = finitePercent(usedValue)
  if (used == null) return null
  const remainingPercent = Math.round(100 - used)
  const span = SPANS[bucket?.window] || Number(bucket?.span) || undefined
  return {
    name,
    used,
    remaining: remainingPercent,
    display: `${remainingPercent}% remaining`,
    ...(span ? { span } : {}),
    ...resetFields(bucket),
  }
}

export function parseUsagePayload(payload) {
  const groups = payload?.command?.data?.groups
    ?? payload?.data?.groups
    ?? payload?.groups
    ?? []
  const windows = []
  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (!group || typeof group.name !== "string" || !Array.isArray(group.buckets)) continue
      for (const bucket of group.buckets) {
        const name = typeof bucket?.name === "string" ? bucket.name : "quota"
        const window = bucketWindow(`${group.name} · ${name}`, bucket)
        if (window) windows.push(window)
      }
    }
  }

  if (!windows.length && Array.isArray(payload?.windows)) {
    for (const item of payload.windows) {
      const window = bucketWindow(item?.name || "quota", item)
      if (window) windows.push(window)
    }
  }
  if (!windows.length) throw new Error("agy /usage returned no quota buckets")
  return { windows, signIn: "kept" }
}

function runUsage(runtime, env) {
  const args = ["-p", "/usage", "--output-format", "json", "--print-timeout", "30s"]
  const spec = commandSpec(runtime.executable || runtime.command, args, env)
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: env.MAGPIE_AGY_CWD || process.cwd(),
      env: runtimeEnvironment(runtime, env),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new Error(`agy /usage timed out after ${USAGE_TIMEOUT_MS}ms`))
    }, USAGE_TIMEOUT_MS)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(new Error(`failed to start agy /usage: ${error.message}`, { cause: error }))
    })
    child.on("exit", (code, signal) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`agy /usage failed (code=${code}, signal=${signal}): ${stderr.trim() || "no diagnostic output"}`))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch (error) {
        reject(new Error(`agy /usage returned invalid JSON: ${stdout.trim().slice(0, 200)}`, { cause: error }))
      }
    })
  })
}

export async function readUsage(env = process.env) {
  const runtime = resolveRuntime(env)
  if (!runtime.executable) {
    throw new Error("agy /usage requires the official agy executable; custom MAGPIE_AGY_COMMAND is not supported for quota reads")
  }
  return runUsage(runtime, env)
}

export async function usage(env = process.env) {
  try {
    return parseUsagePayload(await readUsage(env))
  } catch (error) {
    return { error: `Antigravity quota read failed: ${error?.message || error}`, windows: [], signIn: "kept" }
  }
}

export const _usageInternals = { bucketWindow, resetFields }

