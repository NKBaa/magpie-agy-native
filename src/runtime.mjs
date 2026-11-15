import { accessSync, constants, existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join, resolve } from "node:path"

const DEFAULT_ACP_ARGS = ["acp"]

function parseArray(value, label) {
  if (!value) return null
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(`${label} must be a JSON string array`, { cause: error })
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${label} must be a non-empty JSON string array`)
  }
  return parsed
}

function isFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function isExecutable(path) {
  if (!isFile(path)) return false
  if (process.platform === "win32") return true
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function pathCandidates(name, env) {
  if (process.platform !== "win32") return [name]
  const extensions = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  return [name, ...extensions.map((extension) => `${name}${extension}`)]
}

function findOnPath(env, names) {
  const entries = (env.PATH || env.Path || "").split(delimiter).filter(Boolean)
  for (const directory of entries) {
    for (const name of names) {
      for (const candidate of pathCandidates(name, env)) {
        const path = join(directory, candidate)
        if (isExecutable(path)) return path
      }
    }
  }
  return null
}

function commonCandidates(env) {
  const home = env.USERPROFILE || env.HOME || homedir()
  if (process.platform === "win32") {
    return [
      join(home, ".local", "bin", "agy.exe"),
      join(home, ".local", "bin", "agy.cmd"),
      join(env.APPDATA || join(home, "AppData", "Roaming"), "npm", "agy.cmd"),
      join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "agy", "agy.exe"),
      join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Programs", "agy", "agy.exe"),
      join(env.ProgramFiles || "C:\\Program Files", "Google", "Antigravity", "agy.exe"),
    ]
  }
  return [
    join(home, ".local", "bin", "agy"),
    join(home, ".npm-global", "bin", "agy"),
    "/usr/local/bin/agy",
    "/usr/bin/agy",
    "/config/home/.local/bin/agy",
  ]
}

function quoteCmdArg(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

export function commandSpec(command, args, env = process.env) {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) return { command, args }
  const comspec = env.ComSpec || env.COMSPEC || "cmd.exe"
  const line = [command, ...args].map(quoteCmdArg).join(" ")
  return { command: comspec, args: ["/d", "/s", "/c", line] }
}

function withGeminiDir(args, geminiDir) {
  if (!geminiDir) return args
  if (args.some((arg) => String(arg).startsWith("--gemini_dir="))) return args
  return [...args, `--gemini_dir=${geminiDir}`]
}

export function resolveRuntime(env = process.env, { geminiDir } = {}) {
  const home = geminiDir || env.MAGPIE_AGY_HOME || env.GEMINI_HOME || undefined
  const configured = parseArray(env.MAGPIE_AGY_COMMAND, "MAGPIE_AGY_COMMAND")
  if (configured) {
    const args = withGeminiDir(configured.slice(1), geminiDir)
    const wrapped = commandSpec(configured[0], args, env)
    return {
      command: wrapped.command,
      args: wrapped.args,
      executable: configured[0],
      home,
      geminiDir,
      source: "MAGPIE_AGY_COMMAND",
    }
  }

  const explicit = env.MAGPIE_AGY_BIN || env.AGY_BIN || env.AGY_PATH
  const explicitResolved = explicit
    ? ((explicit.includes("/") || explicit.includes("\\")) ? resolve(explicit) : findOnPath(env, [explicit]) || resolve(explicit))
    : null
  let command = explicit ? explicitResolved : findOnPath(env, ["agy"])
  let source = env.MAGPIE_AGY_BIN ? "MAGPIE_AGY_BIN" : env.AGY_BIN ? "AGY_BIN" : env.AGY_PATH ? "AGY_PATH" : "PATH"

  if (explicit && (!command || !isExecutable(command))) {
    throw new Error(`MAGPIE_AGY_BIN is not an executable file: ${explicit}`)
  }
  if (!explicit && (!command || !isExecutable(command))) {
    command = commonCandidates(env).find(isExecutable) || null
    source = "common-install-path"
  }
  if (!command) {
    const suffix = process.platform === "win32" ? "agy.exe" : "agy"
    throw new Error(
      `official Antigravity CLI not found (${suffix}). Install it and sign in with \`agy\`, ` +
      "or set MAGPIE_AGY_BIN to the executable, or MAGPIE_AGY_COMMAND to a JSON argv array.",
    )
  }

  const args = withGeminiDir(
    parseArray(env.MAGPIE_AGY_ACP_ARGS, "MAGPIE_AGY_ACP_ARGS") || DEFAULT_ACP_ARGS,
    geminiDir,
  )
  const wrapped = commandSpec(command, args, env)
  return {
    command: wrapped.command,
    args: wrapped.args,
    executable: command,
    home,
    geminiDir,
    source,
  }
}

export function runtimeEnvironment(runtime, env = process.env) {
  const output = { ...env }
  if (runtime.home) output.GEMINI_HOME = runtime.home
  if (runtime.geminiDir && process.platform === "win32" && !output.WSL_INTEROP) output.WSL_INTEROP = "1"
  output.NO_COLOR = "1"
  output.TERM = output.TERM || "dumb"
  return output
}

export function runtimeDescription(runtime) {
  return JSON.stringify([runtime.executable || runtime.command, ...runtime.args])
}

export function inspectRuntime(env = process.env, options = {}) {
  try {
    const runtime = resolveRuntime(env, options)
    return {
      ok: true,
      binary: runtime.executable || runtime.command,
      args: runtime.args,
      source: runtime.source,
      geminiDir: runtime.geminiDir || null,
    }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
}

export const _runtimeInternals = { parseArray, findOnPath, commonCandidates, withGeminiDir }

