#!/usr/bin/env node
import readline from "node:readline"

const expectedGeminiDir = process.env.FAKE_AGY_EXPECT_GEMINI_DIR
if (expectedGeminiDir && !process.argv.includes(`--gemini_dir=${expectedGeminiDir}`)) {
  console.error(`missing --gemini_dir=${expectedGeminiDir}; argv=${process.argv.slice(2).join(" ")}`)
  process.exit(42)
}
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let sessionId = "fake-acp-session"
let promptCounter = 0
let pendingPermission = null

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value })
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } })
}

async function requestPermission() {
  if (process.env.FAKE_AGY_REQUEST_PERMISSION !== "1") return
  const id = 9000 + promptCounter
  send({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: { title: "write file" },
      options: [
        { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
        { optionId: "reject-once", kind: "reject_once", name: "Reject" },
      ],
    },
  })
  await new Promise((resolve, reject) => {
    pendingPermission = { id, resolve, reject }
  })
}

async function handlePrompt(id) {
  promptCounter += 1
  await requestPermission()
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Checking the request. " } },
    },
  })
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } },
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " from agy." } },
    },
  })
  result(id, {
    stopReason: "end_turn",
    usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, thoughtTokens: 2, cachedReadTokens: 4 },
  })
}

input.on("line", (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.method) {
    if (message.id == null) return
    if (message.method === "initialize") {
      return result(message.id, {
        protocolVersion: 1,
        agentInfo: { name: "fake-agy", version: "1.5.3" },
        agentCapabilities: { promptCapabilities: { image: true }, sessionCapabilities: { resume: true } },
      })
    }
    if (message.method === "session/new") {
      return result(message.id, {
        sessionId,
        models: {
          currentModelId: "gemini-4-argon-medium",
          availableModels: [
            { modelId: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
            { modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
            { modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
            { modelId: "gemini-4-pro", name: "Gemini 4 Pro" },
          ],
        },
        configOptions: [{ id: "model", category: "model", name: "Model" }],
      })
    }
    if (message.method === "session/set_config_option") return result(message.id, {})
    if (message.method === "session/prompt") return void handlePrompt(message.id)
    if (message.method === "session/cancel") return result(message.id, {})
    return error(message.id, -32601, "method not found")
  }

  if (pendingPermission && message.id === pendingPermission.id) {
    const optionId = message.result?.outcome?.optionId
    const expectedOption = process.env.FAKE_AGY_REQUIRE_ALLOW === "1" ? "allow-once" : "reject-once"
    if (optionId !== expectedOption) {
      pendingPermission.reject(new Error(`unexpected permission response: ${JSON.stringify(message)}`))
    } else {
      pendingPermission.resolve()
    }
    pendingPermission = null
  }
})

input.on("close", () => process.exit(0))


