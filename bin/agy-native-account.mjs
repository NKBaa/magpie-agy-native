#!/usr/bin/env node
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import {
  accountsRoot,
  ensureAccountDir,
  hasAccountToken,
  validateAccountName,
  _accountInternals,
} from "../src/accounts.mjs"
import { commandSpec, resolveRuntime, runtimeEnvironment } from "../src/runtime.mjs"

const env = process.env
const [command, arg] = process.argv.slice(2)

function usage() {
  console.log(`agy-native-account

Usage:
  agy-native-account list
  agy-native-account path <name>
  agy-native-account login <name>

Environment:
  MAGPIE_AGY_ACCOUNTS_DIR   default: ${accountsRoot(env)}
  MAGPIE_AGY_BIN            path to the official agy executable
`)
}

function list() {
  const root = accountsRoot(env)
  console.log(`accounts root: ${root}`)
  console.log("  (default)\tglobal agy login")
  let names = []
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .filter((name) => {
        try { return validateAccountName(name) === name } catch { return false }
      })
      .sort()
  } catch {}
  for (const name of names) {
    const dir = path.join(root, name)
    console.log(`  ${name}\t${hasAccountToken(dir) ? "signed in" : "needs login"}\t${dir}`)
  }
  if (!names.length) console.log("  (no isolated profiles yet; run `agy-native-account login work`)")
}

async function login(name) {
  const normalized = validateAccountName(name)
  const dir = ensureAccountDir(normalized, env)
  const runtime = resolveRuntime(env, { geminiDir: dir })
  if (!runtime.executable) throw new Error("login requires the official agy executable")
  const args = [ `--gemini_dir=${dir}` ]
  const spec = commandSpec(runtime.executable, args, env)
  console.log(`Signing in agy profile "${normalized}"`)
  console.log(`  GEMINI_HOME=${dir}`)
  console.log(`  ${runtime.executable} ${args.join(" ")}`)
  console.log("")
  const child = spawn(spec.command, spec.args, {
    cwd: env.MAGPIE_AGY_CWD || process.cwd(),
    env: runtimeEnvironment({ ...runtime, geminiDir: dir, home: dir }, env),
    stdio: "inherit",
    windowsHide: false,
    shell: false,
  })
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("exit", resolve)
  })
  if (code !== 0) throw new Error(`agy login exited with code ${code}`)
  const token = _accountInternals.tokenPath(dir)
  if (!hasAccountToken(dir)) {
    throw new Error(`agy finished but no token file was created at ${token}`)
  }
  console.log(`\nProfile "${normalized}" is ready:`)
  console.log(token)
}

try {
  if (!command || command === "help" || command === "--help" || command === "-h") usage()
  else if (command === "list") list()
  else if (command === "path") {
    if (!arg) throw new Error("path requires an account name")
    console.log(ensureAccountDir(arg, env))
  } else if (command === "login") {
    if (!arg) throw new Error("login requires an account name")
    await login(arg)
  } else {
    usage()
    process.exitCode = 1
  }
} catch (error) {
  console.error(`agy-native-account: ${error?.message || error}`)
  process.exitCode = 1
}

