import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const DEFAULT_ACCOUNT = Object.freeze({
  key: "agy",
  name: null,
  dir: null,
  label: "Default agy login",
})

const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function accountsRoot(env = process.env) {
  return path.resolve(
    env.MAGPIE_AGY_ACCOUNTS_DIR
      || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "magpie-agy-native", "accounts"),
  )
}

export function validateAccountName(value) {
  const name = String(value || "").trim()
  if (!ACCOUNT_NAME.test(name)) {
    throw new Error("Account name must be 1-64 ASCII letters, digits, dots, underscores or hyphens")
  }
  return name
}

export function accountDir(name, env = process.env) {
  return path.join(accountsRoot(env), validateAccountName(name))
}

export function tokenPath(dir) {
  return path.join(dir, "antigravity-cli", "antigravity-oauth-token")
}

export function hasAccountToken(dir) {
  try {
    return fs.existsSync(tokenPath(dir)) && fs.statSync(tokenPath(dir)).isFile()
  } catch {
    return false
  }
}

export function ensureAccountDir(name, env = process.env) {
  const dir = accountDir(name, env)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export function listAccounts(env = process.env) {
  const root = accountsRoot(env)
  const accounts = [DEFAULT_ACCOUNT]
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue
      if (!ACCOUNT_NAME.test(entry.name)) continue
      const dir = path.join(root, entry.name)
      if (!hasAccountToken(dir)) continue
      accounts.push({ key: `agy:${encodeURIComponent(entry.name)}`, name: entry.name, dir, label: entry.name })
    }
  } catch {}
  return accounts
}

export function accountFromAuth(auth, { env = process.env, allowMissingToken = false } = {}) {
  if (!auth || auth.key === "agy" || auth.key === "agy-native") return DEFAULT_ACCOUNT
  if (typeof auth.key !== "string" || !auth.key.startsWith("agy:")) {
    throw Object.assign(new Error("The selected agy account profile is invalid; register it again"), {
      code: "sign_in_required",
      statusCode: 401,
    })
  }
  let name
  try {
    name = decodeURIComponent(auth.key.slice(4))
    if (auth.key !== `agy:${encodeURIComponent(name)}`) throw new Error("non-canonical key")
  } catch {
    throw Object.assign(new Error("The selected agy account profile is invalid; register it again"), {
      code: "sign_in_required",
      statusCode: 401,
    })
  }
  const dir = accountDir(name, env)
  if (!allowMissingToken && !hasAccountToken(dir)) {
    throw Object.assign(new Error(
      `agy account profile "${name}" has no OAuth token at ${tokenPath(dir)}. ` +
      `Run: agy --gemini_dir="${dir}"`,
    ), { code: "sign_in_required", statusCode: 401 })
  }
  return { key: `agy:${encodeURIComponent(name)}`, name, dir, label: name }
}

export function accountAuthResult(name, env = process.env) {
  if (name == null || String(name).trim() === "") {
    return {
      type: "success",
      key: "agy",
      accountId: "agy-default",
      metadata: { email: "Default agy login" },
    }
  }
  const normalized = validateAccountName(name)
  const dir = ensureAccountDir(normalized, env)
  return {
    type: "success",
    key: `agy:${encodeURIComponent(normalized)}`,
    accountId: `agy-${normalized}`,
    metadata: {
      email: normalized,
      profile: dir,
      signedIn: hasAccountToken(dir),
    },
  }
}

export function accountEnvironment(env, dir) {
  const output = { ...env }
  if (dir) {
    output.GEMINI_HOME = dir
    if (process.platform === "win32" && !output.WSL_INTEROP) output.WSL_INTEROP = "1"
  }
  return output
}

export const _accountInternals = { ACCOUNT_NAME, tokenPath }
