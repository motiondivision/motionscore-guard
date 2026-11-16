/* Pure helpers for the Motion Performance Guard action. No I/O here, so
 * lib.node-test.mjs can cover them with `node --test`. */

export const TIERS = ["S", "A", "B", "C", "D", "F"]
export const OIDC_AUDIENCE = "https://api.motion.dev/guard"
export const MAX_SITEMAP_PAGES = 4

export class ConfigError extends Error {}

/* Newline-separated `pages` input. Empty means auto (sitemap). */
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

/* Picks up to `limit` extra paths from a sitemap, shortest paths first.
 * Preview deploys often serve a sitemap that lists production URLs, so the
 * path is used whatever the host; the base URL's path prefix applies only
 * to same-host entries. "/" always comes
 * first. Paths are relative to the base URL. */
export function pickSitemapPaths(xml, baseUrl, limit = MAX_SITEMAP_PAGES) {
  let base
  try {
    base = new URL(baseUrl)
  } catch {
    return ["/"]
  }
  const prefix = trimSlash(base.pathname)
  const seen = new Set(["/"])
  const candidates = []

  for (const match of (xml ?? "").matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)) {
    let loc
    try {
      loc = new URL(match[1].replace(/&amp;/g, "&"), base)
    } catch {
      continue
    }
    // Sitemap indexes list other sitemaps, not pages.
    if (/\.xml(\.gz)?$/i.test(loc.pathname)) continue
    let path = loc.pathname
    if (prefix && loc.host === base.host) {
      if (path !== prefix && !path.startsWith(`${prefix}/`)) continue
      path = path.slice(prefix.length) || "/"
    }
    path = path.length > 1 ? trimSlash(path) || "/" : path
    if (seen.has(path)) continue
    seen.add(path)
    candidates.push(path)
  }

  candidates.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
  return ["/", ...candidates.slice(0, limit)]
}

/* "baseline" for a push to the default branch, or a deployment of it.
 * Everything else (pull requests, preview deploys, manual runs) is "pr". */
export function detectKind(eventName, event, ref) {
  const defaultBranch = event?.repository?.default_branch
  if (!defaultBranch) return "pr"
  // The API accepts baselines only from these events, on the default
  // branch. A deployment_status of production is a "pr" run: with no open
  // pull request for its commit, the API records it and posts nothing.
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

export function buildPayload({ kind, sha, baseUrl, pages, policy }) {
  return {
    kind,
    sha,
    baseUrl: trimSlash(baseUrl),
    pages: pages.map(({ path, summary }) => ({ path, summary: summary ?? null })),
    policy: { floor: policy.floor, maxDrop: policy.maxDrop },
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
      text: message || "This repository is not covered by a Motion+ Pro plan.",
    }
  }
  if (status === 404 && body?.error === "not_installed") {
    return {
      exitCode: 0,
      level: "warning",
      verdict: "not_installed",
      checkUrl: "",
      link: body?.installUrl ?? "",
      text: message || "The Motion GitHub App is not installed on this repository.",
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
