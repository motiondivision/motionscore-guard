/* Sends the per-page --guard summaries to the Motion Performance Guard API.
 * The API checks the Motion Cloud entitlement, diffs against the main-branch
 * baseline, and posts the PR comment and check run. This script never fails
 * the job on the verdict: the check run is the gate.
 * Run as: node send.mjs <dir> with BASE_URL, API_URL, FLOOR and MAX_DROP in
 * the env. <dir> holds pages.txt and summary-<n>.json from the audit step. */
import { readFileSync, existsSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import {
  OIDC_AUDIENCE,
  ConfigError,
  buildPayload,
  detectKind,
  parsePages,
  detectSha,
  escapeCommand,
  interpretResponse,
  parsePolicy,
  renderStepSummary,
} from "./lib.mjs"

const dir = process.argv[2]
const baseUrl = process.env.BASE_URL ?? ""
const apiUrl = (process.env.API_URL || "https://api.motion.dev").replace(/\/+$/, "")
const eventName = process.env.GITHUB_EVENT_NAME ?? ""

function command(level, text) {
  console.log(`::${level}::${escapeCommand(text)}`)
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

function finish(result, context) {
  command(result.level, result.link ? `${result.text} ${result.link}` : result.text)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderStepSummary(result, context))
  }
  setOutput("verdict", result.verdict)
  setOutput("check-url", result.checkUrl ?? "")
  process.exit(result.exitCode)
}

let policy
try {
  policy = parsePolicy(process.env.FLOOR, process.env.MAX_DROP)
} catch (err) {
  if (err instanceof ConfigError) {
    command("error", err.message)
    process.exit(1)
  }
  throw err
}

if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
  command(
    "error",
    "Motion Performance Guard signs in with GitHub's OIDC token. Add `permissions: id-token: write` to the workflow or job. See https://github.com/motiondivision/motionscore-guard#setup",
  )
  process.exit(1)
}

let event = {}
try {
  if (process.env.GITHUB_EVENT_PATH) event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
} catch {
  // A missing event file only affects kind and SHA detection.
}

const paths = existsSync(join(dir, "pages.txt"))
  ? readFileSync(join(dir, "pages.txt"), "utf8").split("\n").filter(Boolean)
  : []

const pages = paths.map((path, index) => {
  const file = join(dir, `summary-${index + 1}.json`)
  try {
    return { path, summary: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null }
  } catch {
    return { path, summary: null }
  }
})

const kind = detectKind(eventName, event, process.env.GITHUB_REF)
const sha = detectSha(eventName, event, process.env.GITHUB_SHA)
const pagesSet = parsePages(process.env.PAGES).length > 0
const payload = buildPayload({ kind, sha, baseUrl, pages, policy, pagesSet })
const context = { kind, baseUrl, pages }

console.log(`Sending ${pages.length} page(s) to ${apiUrl}/guard/runs as a ${kind} run for ${sha}`)

let idToken
try {
  const tokenUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL)
  tokenUrl.searchParams.set("audience", OIDC_AUDIENCE)
  const res = await fetch(tokenUrl, {
    headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  idToken = (await res.json()).value
  if (!idToken) throw new Error("empty token")
} catch (err) {
  command("error", `Could not get a GitHub OIDC token (${err.message}). Check that the job has \`permissions: id-token: write\`.`)
  process.exit(1)
}

async function post() {
  const res = await fetch(`${apiUrl}/guard/runs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
      "User-Agent": "motionscore-guard-action/2",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  })
  let body = null
  try {
    body = await res.json()
  } catch {
    // Non-JSON bodies (proxy errors) are handled by status alone.
  }
  return { status: res.status, body }
}

// Retry once on network errors and 5xx. The API should treat a repeat of
// the same kind and SHA as the same run.
let response
for (let attempt = 1; attempt <= 2; attempt++) {
  try {
    response = await post()
    if (response.status < 500) break
  } catch (err) {
    response = { status: null, body: { message: err.message } }
  }
  if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 3000))
}

finish(interpretResponse(response.status, response.body), context)
