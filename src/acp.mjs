import { spawn } from "node:child_process"
import { runtimeEnvironment, runtimeDescription } from "./runtime.mjs"

const MAX_LINE_BYTES = 64 * 1024 * 1024
const STDERR_TAIL_BYTES = 16 * 1024
const PACKAGE_VERSION = "0.1.0"
const CLIENT_INFO = Object.freeze({ name: "magpie-agy-native", version: PACKAGE_VERSION })

function numberFromEnv(env, key, fallback) {
  const value = Number(env[key])
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function protocolError(method, message) {
  const error = new Error(`agy ACP ${method} failed: ${message}`)
  error.code = "agy_acp_error"
  return error
}

function withTimeout(promise, timeoutMs, message) {
  if (!timeoutMs) return promise
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function selectedPermission(params, policy) {
  const options = Array.isArray(params?.options) ? params.options : []
  if (policy === "allow") {
    const allow = options.find((option) => option?.kind === "allow_once")
      || options.find((option) => option?.kind === "allow_always")
    if (allow?.optionId) return { outcome: { outcome: "selected", optionId: allow.optionId } }
  }
  const reject = options.find((option) => option?.kind === "reject_once")
    || options.find((option) => option?.kind === "reject_always")
  return reject?.optionId
    ? { outcome: { outcome: "selected", optionId: reject.optionId } }
    : { outcome: { outcome: "cancelled" } }
}

export class AcpClient {
  constructor({ runtime, onUpdate, permissionPolicy = "deny", env = process.env, debug = false }) {
    this.runtime = runtime
    this.onUpdate = onUpdate
    this.permissionPolicy = permissionPolicy
    this.env = env
    this.debug = debug
    this.child = null
    this.buffer = ""
    this.stderr = ""
    this.nextId = 0
    this.pending = new Map()
    this.closed = false
    this.exited = false
    this.sessionId = null
    this.session = null
    this.activePrompt = false
    this.closeReason = null
    this.forceKillTimer = null
  }

  async start({ cwd = process.cwd(), signal } = {}) {
    if (this.child) throw new Error("agy ACP client already started")
    const startTimeout = numberFromEnv(this.env, "MAGPIE_AGY_START_TIMEOUT_MS", 45_000)
    this.child = spawn(this.runtime.command, this.runtime.args, {
      cwd,
      env: runtimeEnvironment(this.runtime, this.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    })
    this.child.stdout.setEncoding("utf8")
    this.child.stderr.setEncoding("utf8")
    this.child.stdout.on("data", (chunk) => this.#receive(chunk))
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_BYTES)
      if (this.debug) console.error(`[agy-native stderr] ${String(chunk).trimEnd()}`)
    })
    this.child.stdin.on("error", () => {})
    this.child.on("error", (error) => this.#fail(new Error(`failed to start agy ACP (${runtimeDescription(this.runtime)}): ${error.message}`, { cause: error })))
    this.child.on("exit", (code, signalName) => {
      this.exited = true
      if (this.forceKillTimer) clearTimeout(this.forceKillTimer)
      this.forceKillTimer = null
      if (this.closed) return
      const tail = this.stderr.trim()
      this.#fail(new Error(
        `agy ACP exited unexpectedly (code=${code}, signal=${signalName})` +
        `${tail ? `: ${tail}` : ""}`,
      ))
    })

    if (signal) {
      if (signal.aborted) throw signal.reason || new Error("aborted")
      this.abortHandler = () => {
        this.cancelTurn()
        this.close(new DOMException("The request was aborted.", "AbortError"))
      }
      signal.addEventListener("abort", this.abortHandler, { once: true })
    }

    try {
      const initialized = await withTimeout(
        this.request("initialize", {
          protocolVersion: 1,
          clientInfo: CLIENT_INFO,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        }),
        startTimeout,
        `agy ACP initialize timed out after ${startTimeout}ms`,
      )
      this.initializeResult = initialized
      this.notify("initialized", {})
      const session = await withTimeout(
        this.request("session/new", { cwd, mcpServers: [] }),
        startTimeout,
        `agy ACP session/new timed out after ${startTimeout}ms`,
      )
      if (!session?.sessionId) throw protocolError("session/new", "response did not contain sessionId")
      this.session = session
      this.sessionId = session.sessionId
      return session
    } catch (error) {
      this.close(error)
      throw error
    }
  }

  request(method, params, timeoutMs = 0) {
    if (this.closed || this.exited) {
      return Promise.reject(this.closeReason || new Error("agy ACP connection is closed"))
    }
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`agy ACP ${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        : null
      timer?.unref?.()
      this.pending.set(id, { resolve, reject, method, timer })
      if (!this.#write({ jsonrpc: "2.0", id, method, params })) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(this.closeReason || new Error("agy ACP stdin is closed"))
      }
    })
  }

  notify(method, params) {
    if (!this.closed && !this.exited) this.#write({ jsonrpc: "2.0", method, params })
  }

  cancelTurn() {
    if (this.activePrompt && this.sessionId) {
      this.notify("session/cancel", { sessionId: this.sessionId })
      this.activePrompt = false
    }
  }

  async setModel(wireModel) {
    if (!wireModel || !this.sessionId) return
    const session = this.session || {}
    const current = session?.models?.currentModelId
    if (current === wireModel) return
    const options = Array.isArray(session.configOptions) ? session.configOptions : []
    const option = options.find((item) =>
      item?.id === "model"
      || item?.configId === "model"
      || item?.category === "model"
      || /^model$/i.test(item?.name || ""),
    )
    const configId = option?.id || option?.configId || "model"
    const timeoutMs = numberFromEnv(this.env, "MAGPIE_AGY_CONFIG_TIMEOUT_MS", 30_000)
    await withTimeout(
      this.request("session/set_config_option", {
        sessionId: this.sessionId,
        configId,
        value: wireModel,
      }),
      timeoutMs,
      `agy ACP model selection timed out after ${timeoutMs}ms`,
    )
    if (this.session?.models) this.session.models.currentModelId = wireModel
  }

  async prompt(parts) {
    if (!this.sessionId) throw new Error("agy ACP session has not started")
    this.activePrompt = true
    try {
      return await this.request("session/prompt", { sessionId: this.sessionId, prompt: parts })
    } finally {
      this.activePrompt = false
    }
  }

  close(reason = null) {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason
    if (this.abortHandler) {
      // The owning Request signal is one-shot; there is nothing to detach from
      // without retaining the signal, so let the listener be collected with us.
      this.abortHandler = null
    }
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(reason || new Error("agy ACP connection closed"))
    }
    this.pending.clear()
    try {
      this.child?.stdin?.end()
    } catch {}
    if (this.child && !this.exited) {
      try {
        this.child.kill("SIGTERM")
      } catch {}
      this.forceKillTimer = setTimeout(() => {
        this.forceKillTimer = null
        if (!this.exited) {
          try {
            this.child.kill("SIGKILL")
          } catch {}
        }
      }, 2_000)
      this.forceKillTimer.unref?.()
    }
  }

  #write(message) {
    try {
      if (!this.child?.stdin?.writable) return false
      this.child.stdin.write(`${JSON.stringify(message)}\n`)
      return true
    } catch (error) {
      this.#fail(new Error(`failed to write to agy ACP: ${error.message}`, { cause: error }))
      return false
    }
  }

  #receive(chunk) {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_LINE_BYTES) {
      this.#fail(new Error(`agy ACP emitted a message larger than ${MAX_LINE_BYTES} bytes`))
      return
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n")
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        if (this.debug) console.error(`[agy-native] ignored non-JSON stdout: ${line.slice(0, 240)}`)
        continue
      }
      this.#dispatch(message)
    }
  }

  #dispatch(message) {
    if (!message || typeof message !== "object") return
    if ("id" in message && !("method" in message)) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        entry.reject(protocolError(entry.method, message.error.message || JSON.stringify(message.error)))
      } else {
        entry.resolve(message.result ?? null)
      }
      return
    }
    if (typeof message.method !== "string") return
    if (!Object.hasOwn(message, "id")) {
      if (message.method === "session/update") {
        const params = message.params || {}
        if (!this.sessionId || !params.sessionId || params.sessionId === this.sessionId) {
          this.onUpdate?.(params.update || params)
        }
      }
      return
    }

    Promise.resolve()
      .then(() => this.#serveRequest(message.method, message.params || {}))
      .then(
        (result) => this.#write({ jsonrpc: "2.0", id: message.id, result: result ?? null }),
        (error) => this.#write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: error?.code ?? -32603, message: String(error?.message || error) },
        }),
      )
  }

  #serveRequest(method, params) {
    if (method === "session/request_permission") {
      return selectedPermission(params, this.permissionPolicy)
    }
    const error = new Error(`this adapter does not provide ACP client method ${method}`)
    error.code = -32601
    throw error
  }

  #fail(error) {
    if (this.closed) return
    this.closeReason = error
    this.close(error)
  }
}

export const _acpInternals = { withTimeout, selectedPermission, CLIENT_INFO }





