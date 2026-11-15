import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"

import { AgyNativePlugin, _internal } from "../index.mjs"
import { buildConversation } from "../src/prompt.mjs"
import { groupModels, chooseWireModel } from "../src/models.mjs"
import { parseUsagePayload } from "../src/usage.mjs"
import { classifyError } from "../src/adapter.mjs"
import { ensureAccountDir, tokenPath } from "../src/accounts.mjs"
import { resolveRuntime } from "../src/runtime.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const fakeAgy = join(here, "fake-agy.mjs")
const originalEnv = { ...process.env }

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MAGPIE_AGY_") || key.startsWith("FAKE_AGY_")) delete process.env[key]
  }
  process.env.MAGPIE_AGY_COMMAND = JSON.stringify([process.execPath, fakeAgy])
})

after(() => {
  process.env = originalEnv
})

function parseSse(text) {
  const chunks = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue
    const value = line.slice(6)
    if (value === "[DONE]") continue
    chunks.push(JSON.parse(value))
  }
  return chunks
}

test("groups ACP model variants into one Magpie model", () => {
  const models = groupModels([
    { modelId: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
    { modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
    { modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
    { modelId: "gemini-4-pro", name: "Gemini 4 Pro" },
  ])
  assert.deepEqual(Object.keys(models).sort(), ["gemini-4-argon", "gemini-4-pro"])
  assert.deepEqual(models["gemini-4-argon"].efforts, ["low", "medium", "high"])
  assert.equal(chooseWireModel("gemini-4-argon", "high", [
    "gemini-4-argon-low",
    "gemini-4-argon-medium",
    "gemini-4-argon-high",
  ]), "gemini-4-argon-high")
})

test("builds a bounded native ACP conversation", () => {
  const prompt = buildConversation([
    { role: "system", content: "Be concise." },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "continue" },
  ])
  assert.match(prompt.text, /SYSTEM INSTRUCTIONS:\nBe concise\./)
  assert.match(prompt.text, /USER:\ncontinue/)
  assert.equal(prompt.truncated, false)
})

test("parses native agy quota buckets", () => {
  const usage = parseUsagePayload({
    command: {
      data: {
        groups: [{
          name: "Gemini",
          buckets: [{
            name: "5h",
            window: "5h",
            remaining_fraction: 0.75,
            reset_time: "2026-11-15T20:00:00Z",
          }],
        }],
      },
    },
  })
  assert.equal(usage.windows[0].used, 25)
  assert.equal(usage.windows[0].remaining, 75)
  assert.equal(usage.windows[0].span, 18000)
})

test("streams an OpenAI-compatible response from ACP", async () => {
  process.env.FAKE_AGY_REQUEST_PERMISSION = "1"
  const plugin = await AgyNativePlugin({ magpie: { option: () => false } })
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "agy-native" }))
  const response = await loader.fetch(new Request("http://agy-native.invalid/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gemini-4-argon",
      reasoning_effort: "high",
      stream: true,
      messages: [{ role: "user", content: "Say hi" }],
    }),
  }))
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type"), /text\/event-stream/)
  const chunks = parseSse(await response.text())
  const text = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content || "").join("")
  assert.equal(text, "Hello from agy.")
  assert.ok(chunks.some((chunk) => chunk.choices?.[0]?.delta?.reasoning_content))
  const finish = chunks.find((chunk) => chunk.choices?.[0]?.finish_reason === "stop")
  assert.ok(finish)
  const usage = chunks.find((chunk) => chunk.usage)?.usage
  assert.equal(usage.prompt_tokens, 12)
  assert.equal(usage.completion_tokens, 3)
})

test("auto-approves native agy tools when enabled", async () => {
  process.env.MAGPIE_AGY_AUTO_APPROVE = "1"
  process.env.FAKE_AGY_REQUEST_PERMISSION = "1"
  process.env.FAKE_AGY_REQUIRE_ALLOW = "1"
  const plugin = await AgyNativePlugin({ magpie: { option: () => false } })
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "agy-native" }))
  const response = await loader.fetch("http://agy-native.invalid/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "gemini-4-argon", messages: [{ role: "user", content: "Hi" }] }),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).choices[0].message.content, "Hello from agy.")
})

test("returns a non-streaming completion", async () => {
  const plugin = await AgyNativePlugin({ magpie: { option: () => false } })
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "agy-native" }))
  const response = await loader.fetch("http://agy-native.invalid/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "gemini-4-pro",
      stream: false,
      messages: [{ role: "user", content: "Hello" }],
    }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.choices[0].message.content, "Hello from agy.")
  assert.equal(body.choices[0].finish_reason, "stop")
  assert.equal(body.usage.total_tokens, 15)
})

test("discovers the live ACP model catalog", async () => {
  const models = await _internal.discoverModels(process.env, { force: true })
  assert.ok(models["gemini-4-argon"])
  assert.ok(models["gemini-4-pro"])
})

test("classifies timeouts as retryable 504 errors", () => {
  const classified = classifyError(new Error("agy ACP initialize timed out after 45000ms"))
  assert.equal(classified.status, 504)
  assert.equal(classified.code, "upstream_timeout")
})

test("reports an unknown model as an OpenAI-style error", async () => {
  const plugin = await AgyNativePlugin({ magpie: { option: () => false } })
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "agy-native" }))
  const response = await loader.fetch("http://agy-native.invalid/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "missing-model",
      messages: [{ role: "user", content: "Hello" }],
    }),
  })
  assert.equal(response.status, 404)
  const body = await response.json()
  assert.match(body.error.message, /does not advertise model/)
  assert.equal(body.error.code, "model_not_found")
  assert.equal(body.error.status, 404)
})





test("isolates a named agy account with --gemini_dir", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "magpie-agy-account-test-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  process.env.MAGPIE_AGY_ACCOUNTS_DIR = root

  const plugin = await AgyNativePlugin({ magpie: { option: () => false } })
  const auth = await plugin.auth.methods[0].authorize({ account: "work" })
  assert.equal(auth.type, "success")
  assert.equal(auth.key, "agy:work")
  assert.equal(auth.accountId, "agy-work")

  const dir = ensureAccountDir("work", process.env)
  const token = tokenPath(dir)
  mkdirSync(dirname(token), { recursive: true })
  writeFileSync(token, "{}", { mode: 0o600 })
  process.env.FAKE_AGY_EXPECT_GEMINI_DIR = dir

  const models = await plugin.provider.models({}, { auth })
  assert.ok(models["gemini-4-argon"])
  assert.ok(models["gemini-4-pro"])

  const loader = await plugin.auth.loader(async () => auth)
  const response = await loader.fetch("http://agy-native.invalid/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "gemini-4-argon",
      messages: [{ role: "user", content: "Use the isolated account" }],
    }),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).choices[0].message.content, "Hello from agy.")
})

test("supports AGY_PATH and appends the profile gemini dir", () => {
  const env = { ...process.env, AGY_PATH: process.execPath }
  delete env.MAGPIE_AGY_COMMAND
  delete env.MAGPIE_AGY_BIN
  delete env.AGY_BIN
  const runtime = resolveRuntime(env, { geminiDir: "/config/agy-accounts/work" })
  assert.equal(runtime.executable, process.execPath)
  assert.ok(runtime.args.includes("--gemini_dir=/config/agy-accounts/work"))
})
