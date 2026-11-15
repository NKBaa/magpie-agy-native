import { AcpClient } from "./src/acp.mjs"
import { createChatResponse } from "./src/adapter.mjs"
import { DEFAULT_MODEL_ID, PROVIDER_ID, fallbackModels, groupModels } from "./src/models.mjs"
import { resolveRuntime, runtimeDescription } from "./src/runtime.mjs"
import { usage as readUsage } from "./src/usage.mjs"

const PROVIDER_NAME = "Antigravity 原生接入 agy Native"
const API_BASE = "http://agy-native.invalid/v1"
const ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSIjMTExODI3Ii8+PHBhdGggZD0iTTY0IDE4IDEwNiA5NiA2NCA3NiAyMiA5NloiIGZpbGw9IiM2MEE1RkEiLz48Y2lyY2xlIGN4PSI2NCIgY3k9IjU4IiByPSIxMCIgZmlsbD0iI0ZGRiIvPjwvc3ZnPg=="
const MODEL_CACHE_MS = 5 * 60_000
let modelCache = null
let modelCacheAt = 0
let modelCacheKey = ""

function optionEnabled(ctx, key) {
  try {
    return ctx?.magpie?.option?.(PROVIDER_ID, key) === true
  } catch {
    return false
  }
}

function permissionPolicy(ctx) {
  return (optionEnabled(ctx, "autoApproveTools") || process.env.MAGPIE_AGY_AUTO_APPROVE === "1") ? "allow" : "deny"
}

async function discoverModels(env = process.env, { force = false } = {}) {
  const runtime = resolveRuntime(env)
  const key = runtimeDescription(runtime)
  if (!force && modelCache && modelCacheKey === key && Date.now() - modelCacheAt < MODEL_CACHE_MS) {
    return modelCache
  }
  const client = new AcpClient({ runtime, env })
  try {
    const session = await client.start({ cwd: env.MAGPIE_AGY_CWD || process.cwd() })
    const available = session?.models?.availableModels || []
    const models = groupModels(available)
    if (Object.keys(models).length === 0) throw new Error("agy ACP session returned no available models")
    modelCache = models
    modelCacheAt = Date.now()
    modelCacheKey = key
    return models
  } finally {
    client.close()
  }
}

export async function AgyNativePlugin(ctx = {}) {
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const existing = cfg.provider[PROVIDER_ID] || {}
      cfg.provider[PROVIDER_ID] = {
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        api: API_BASE,
        ...existing,
        models: {
          ...fallbackModels(),
          ...(existing.models || {}),
        },
      }
    },

    auth: {
      provider: PROVIDER_ID,
      icon: ICON,
      maxConcurrency: 4,
      options: [
        {
          key: "autoApproveTools",
          label: "Auto-approve agy agent tools",
          description: "Allow agy's native agent to run workspace tools without an ACP permission prompt. Leave off unless you trust the workspace and account.",
          default: false,
          placement: "top",
        },
      ],
      methods: [{
        type: "api",
        keyless: true,
        label: "Use the existing agy CLI sign-in",
        placeholder: "Run `agy` once to sign in",
        async authorize() {
          return { type: "success", key: "agy-native" }
        },
      }],
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth) return {}
        return {
          baseURL: API_BASE,
          apiKey: "agy-native",
          fetch(input, init) {
            return createChatResponse(input, init, {
              env: process.env,
              permissionPolicy: permissionPolicy(ctx),
            })
          },
        }
      },
      async usage() {
        return readUsage(process.env)
      },
    },

    provider: {
      id: PROVIDER_ID,
      async models() {
        try {
          return await discoverModels(process.env)
        } catch (error) {
          if (process.env.MAGPIE_AGY_DEBUG === "1") {
            console.error(`[agy-native] model discovery failed: ${error?.message || error}`)
          }
          return fallbackModels()
        }
      },
    },

    "chat.headers": async (_input, output) => {
      output.headers["x-agy-native"] = "1"
    },
  }
}

export const _internal = {
  discoverModels,
  fallbackModels,
  groupModels,
  permissionPolicy,
  PROVIDER_ID,
  DEFAULT_MODEL_ID,
  API_BASE,
}




