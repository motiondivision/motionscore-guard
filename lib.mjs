/* Pure helpers for the Motion Performance Guard action. No I/O here, so
 * lib.node-test.mjs can cover them with `node --test`. */

export const TIERS = ["S", "A", "B", "C", "D", "F"]
export const OIDC_AUDIENCE = "https://api.motion.dev/guard"

export class ConfigError extends Error {}

/* Newline-separated `pages` input. Empty means "/" only. */
export function parsePages(input) {
  return (input ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((page) => (page.startsWith("/") ? page : `/${page}`))
}

export function parsePolicy(floorInput, maxDropInput) {
  const raw = (floorInput ?? "").trim().toUpperCase()
  let floor = null
  if (raw !== "" && raw !== "NONE") {
    if (!TIERS.includes(raw)) {
      throw new ConfigError(`floor must be one of S, A, B, C, D, F or "none". Got "${floorInput}".`)
    }
    floor = raw
  }

  const dropRaw = (maxDropInput ?? "").trim()
  const maxDrop = dropRaw === "" ? 1 : Number(dropRaw)
  if (!Number.isInteger(maxDrop) || maxDrop < 0 || maxDrop > TIERS.length - 1) {
    throw new ConfigError(`max-drop must be a whole number from 0 to ${TIERS.length - 1}. Got "${maxDropInput}".`)
  }

  return { floor, maxDrop }
}

function trimSlash(value) {
  return value.replace(/\/+$/, "")
}

/* "baseline" for a push to the default branch, or a deployment of it.
 * Everything else (pull requests, preview deploys, manual runs) is "pr". */
export function detectKind(eventName, event, ref) {
  const defaultBranch = event?.repository?.default_branch
  if (!defaultBranch) return "pr"
  // The API accepts baselines only from these events, on the default
  // branch. Deployments are sent as "pr" runs: the API checks with GitHub
  // whether the deployed commit is on the default branch and, if it is,
  // saves the run as a baseline.
  if (eventName === "push" || eventName === "schedule" || eventName === "workflow_dispatch") {
    return ref === `refs/heads/${defaultBranch}` ? "baseline" : "pr"
  }
  return "pr"
}

/* The commit the audit belongs to. On pull_request events GITHUB_SHA is the
 * merge commit, so use the PR head. Deployments carry their own SHA. */
export function detectSha(eventName, event, fallbackSha) {
  if (eventName === "deployment_status" && event?.deployment?.sha) return event.deployment.sha
  if (eventName.startsWith("pull_request") && event?.pull_request?.head?.sha) return event.pull_request.head.sha
  return fallbackSha ?? ""
}

/* `pagesSet` is false when the workflow gave no `pages:` and Guard audited
 * "/" only, so the check can say how to audit more. */
export function buildPayload({ kind, sha, baseUrl, pages, policy, pagesSet = true }) {
  return {
    kind,
    sha,
    baseUrl: trimSlash(baseUrl),
    pages: pages.map(({ path, summary }) => ({ path, summary: summary ?? null })),
    policy: { floor: policy.floor, maxDrop: policy.maxDrop },
    pagesSet,
  }
}

/* Maps an API response to what the action does with it. `level` is the
 * workflow command used for `text`; exitCode 0 means the job continues. The
 * verdict never fails the job: the check run is the gate. */
export function interpretResponse(status, body) {
  const message = typeof body?.message === "string" ? body.message : ""
  if (status === null) {
    return {
      exitCode: 0,
      level: "warning",
      verdict: "unavailable",
      checkUrl: "",
      text: `Could not reach the Motion Performance Guard API${message ? `: ${message}` : ""}. This run is not graded.`,
    }
  }
  if (status >= 200 && status < 300) {
    const verdict = typeof body?.verdict === "string" ? body.verdict : "unknown"
    return {
      exitCode: 0,
      level: "notice",
      verdict,
      checkUrl: body?.checkRunUrl ?? "",
      commentUrl: body?.commentUrl ?? "",
      text: message || `Verdict: ${verdict}`,
    }
  }
  if (status === 402) {
    return {
      exitCode: 0,
      level: "warning",
      verdict: "not_entitled",
      checkUrl: "",
      link: body?.connectUrl ?? "",
      text: message || "This repository is not covered by a Motion Cloud plan.",
    }
  }
  if (status === 404 && body?.error === "not_installed") {
    return {
      exitCode: 0,
      level: "warning",
      verdict: "not_installed",
      checkUrl: "",
      link: body?.installUrl ?? "",
      text: message || "The Motion Performance app is not installed on this repository.",
    }
  }
  if (status >= 500) {
    return {
      exitCode: 0,
      level: "warning",
      verdict: "unavailable",
      checkUrl: "",
      text: `The Motion Performance Guard API returned ${status}${message ? `: ${message}` : ""}. This run is not graded.`,
    }
  }
  return {
    exitCode: 1,
    level: "error",
    verdict: "error",
    checkUrl: "",
    text: `The Motion Performance Guard API rejected the run (${status}${body?.error ? ` ${body.error}` : ""})${message ? `: ${message}` : ""}`,
  }
}

export function renderStepSummary(result, { kind, baseUrl, pages }) {
  const lines = [
    "### Motion Performance Guard",
    "",
    `**Verdict:** ${result.verdict} · ${kind} run · ${trimSlash(baseUrl)}`,
    "",
    result.text,
  ]
  const links = []
  if (result.checkUrl) links.push(`[Check run](${result.checkUrl})`)
  if (result.commentUrl) links.push(`[PR comment](${result.commentUrl})`)
  if (result.link) links.push(`[Set up Guard](${result.link})`)
  if (links.length > 0) lines.push("", links.join(" · "))
  const failed = pages.filter((p) => !p.summary).map((p) => `\`${p.path}\``)
  if (failed.length > 0) lines.push("", `Audit failed for: ${failed.join(", ")}`)
  return `${lines.join("\n")}\n`
}

/* Escapes a message for a workflow command (::warning::, ::error::). */
export function escapeCommand(text) {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")
}
