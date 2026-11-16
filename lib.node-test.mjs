/* Run with: node --test action/lib.node-test.mjs
 * Named outside vitest's *.test.* pattern because it uses node:test, so the
 * action stays dependency-free in the public mirror. */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  buildPayload,
  detectKind,
  detectSha,
  escapeCommand,
  interpretResponse,
  parsePages,
  parsePolicy,
  pickSitemapPaths,
  renderStepSummary,
} from "./lib.mjs"

const repo = { repository: { default_branch: "main" } }

describe("parsePages", () => {
  it("returns an empty list for auto mode", () => {
    assert.deepEqual(parsePages(""), [])
    assert.deepEqual(parsePages(undefined), [])
    assert.deepEqual(parsePages("  \n \n"), [])
  })

  it("trims lines and adds a leading slash", () => {
    assert.deepEqual(parsePages(" /\npricing \n\n/docs/intro"), ["/", "/pricing", "/docs/intro"])
  })
})

describe("parsePolicy", () => {
  it("applies the defaults", () => {
    assert.deepEqual(parsePolicy("C", "1"), { floor: "C", maxDrop: 1 })
    assert.deepEqual(parsePolicy("", ""), { floor: null, maxDrop: 1 })
  })

  it("accepts lower case tiers and none", () => {
    assert.deepEqual(parsePolicy("a", "0"), { floor: "A", maxDrop: 0 })
    assert.deepEqual(parsePolicy("none", "2"), { floor: null, maxDrop: 2 })
  })

  it("rejects bad values", () => {
    assert.throws(() => parsePolicy("E", "1"), /floor/)
    assert.throws(() => parsePolicy("C", "-1"), /max-drop/)
    assert.throws(() => parsePolicy("C", "1.5"), /max-drop/)
    assert.throws(() => parsePolicy("C", "six"), /max-drop/)
    assert.throws(() => parsePolicy("C", "6"), /max-drop/)
  })
})

describe("pickSitemapPaths", () => {
  const sitemap = (...locs) =>
    `<?xml version="1.0"?><urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join("")}</urlset>`

  it("puts / first, then the shortest paths", () => {
    const xml = sitemap(
      "https://example.com/",
      "https://example.com/docs/getting-started",
      "https://example.com/pricing",
      "https://example.com/blog",
      "https://example.com/about/",
      "https://example.com/docs",
      "https://example.com/careers/engineering",
    )
    assert.deepEqual(pickSitemapPaths(xml, "https://example.com"), ["/", "/blog", "/docs", "/about", "/pricing"])
  })

  it("uses paths from production hosts, and ignores nested sitemaps and duplicates", () => {
    const xml = sitemap(
      "https://www.example.com/a",
      "https://example.com/sitemap-pages.xml",
      "https://example.com/b",
      "https://example.com/b/",
      "https://example.com/b?ref=x",
    )
    assert.deepEqual(pickSitemapPaths(xml, "https://example.com/"), ["/", "/a", "/b"])
  })

  it("reads CDATA and whitespace around locs", () => {
    const xml = "<urlset><url><loc>\n  <![CDATA[https://example.com/x]]>\n</loc></url></urlset>"
    assert.deepEqual(pickSitemapPaths(xml, "https://example.com"), ["/", "/x"])
  })

  it("keeps paths relative to a base URL with a path", () => {
    const xml = sitemap("https://example.com/docs/a", "https://example.com/blog/b", "https://example.com/docs")
    assert.deepEqual(pickSitemapPaths(xml, "https://example.com/docs"), ["/", "/a"])
  })

  it("falls back to / for empty or invalid input", () => {
    assert.deepEqual(pickSitemapPaths("", "https://example.com"), ["/"])
    assert.deepEqual(pickSitemapPaths("<html>not a sitemap</html>", "https://example.com"), ["/"])
    assert.deepEqual(pickSitemapPaths(sitemap("https://example.com/a"), "not a url"), ["/"])
  })

  it("respects the limit", () => {
    const xml = sitemap(...["a", "b", "c", "d", "e", "f"].map((p) => `https://example.com/${p}`))
    assert.equal(pickSitemapPaths(xml, "https://example.com").length, 5)
    assert.deepEqual(pickSitemapPaths(xml, "https://example.com", 2), ["/", "/a", "/b"])
  })
})

describe("detectKind", () => {
  it("is baseline for a push to the default branch", () => {
    assert.equal(detectKind("push", repo, "refs/heads/main"), "baseline")
    assert.equal(detectKind("push", repo, "refs/heads/feature"), "pr")
    assert.equal(detectKind("push", repo, "refs/tags/v1"), "pr")
  })

  it("is baseline for scheduled and manual runs on the default branch", () => {
    assert.equal(detectKind("schedule", repo, "refs/heads/main"), "baseline")
    assert.equal(detectKind("workflow_dispatch", repo, "refs/heads/main"), "baseline")
    assert.equal(detectKind("workflow_dispatch", repo, "refs/heads/feature"), "pr")
  })

  it("never treats a deployment as a baseline", () => {
    assert.equal(detectKind("deployment_status", { ...repo, deployment: { ref: "main" } }), "pr")
  })

  it("is pr for everything else", () => {
    assert.equal(detectKind("pull_request", repo, "refs/pull/1/merge"), "pr")
    assert.equal(detectKind("push", {}, "refs/heads/main"), "pr")
  })
})

describe("detectSha", () => {
  it("prefers the deployment and PR head SHAs", () => {
    assert.equal(detectSha("deployment_status", { deployment: { sha: "dep" } }, "env"), "dep")
    assert.equal(detectSha("pull_request", { pull_request: { head: { sha: "head" } } }, "merge"), "head")
    assert.equal(detectSha("push", {}, "env"), "env")
  })
})

describe("buildPayload", () => {
  it("matches the API contract", () => {
    const summary = { overallTier: "A" }
    const payload = buildPayload({
      kind: "pr",
      sha: "abc",
      baseUrl: "https://preview.example.com/",
      pages: [{ path: "/", summary }, { path: "/broken" }],
      policy: { floor: "C", maxDrop: 1 },
    })
    assert.deepEqual(payload, {
      kind: "pr",
      sha: "abc",
      baseUrl: "https://preview.example.com",
      pages: [{ path: "/", summary }, { path: "/broken", summary: null }],
      policy: { floor: "C", maxDrop: 1 },
    })
  })
})

describe("interpretResponse", () => {
  it("exits 0 for every verdict, including fail", () => {
    for (const verdict of ["pass", "fail", "waived", "baseline"]) {
      const r = interpretResponse(200, { verdict, runId: "r", checkRunUrl: "https://c", message: "m" })
      assert.equal(r.exitCode, 0)
      assert.equal(r.verdict, verdict)
      assert.equal(r.checkUrl, "https://c")
    }
  })

  it("warns and exits 0 when not entitled or not installed", () => {
    const paid = interpretResponse(402, { error: "not_entitled", message: "Upgrade", connectUrl: "https://connect" })
    assert.deepEqual([paid.exitCode, paid.level, paid.verdict, paid.link], [0, "warning", "not_entitled", "https://connect"])
    const app = interpretResponse(404, { error: "not_installed", message: "Install", installUrl: "https://install" })
    assert.deepEqual([app.exitCode, app.level, app.verdict, app.link], [0, "warning", "not_installed", "https://install"])
  })

  it("warns and exits 0 when the API is down", () => {
    assert.deepEqual([interpretResponse(503, null).exitCode, interpretResponse(503, null).level], [0, "warning"])
    assert.equal(interpretResponse(null, { message: "fetch failed" }).verdict, "unavailable")
  })

  it("errors on other client errors", () => {
    const r = interpretResponse(401, { error: "bad_token", message: "Invalid OIDC token" })
    assert.equal(r.exitCode, 1)
    assert.equal(r.level, "error")
    assert.match(r.text, /401 bad_token/)
    assert.equal(interpretResponse(404, { error: "not_found" }).exitCode, 1)
  })
})

describe("renderStepSummary", () => {
  it("lists the verdict, links and failed pages", () => {
    const text = renderStepSummary(
      { verdict: "fail", text: "Grade dropped", checkUrl: "https://c", commentUrl: "https://p" },
      { kind: "pr", baseUrl: "https://x.dev/", pages: [{ path: "/", summary: {} }, { path: "/a", summary: null }] },
    )
    assert.match(text, /\*\*Verdict:\*\* fail · pr run · https:\/\/x\.dev\n/)
    assert.match(text, /\[Check run\]\(https:\/\/c\) · \[PR comment\]\(https:\/\/p\)/)
    assert.match(text, /Audit failed for: `\/a`/)
  })
})

describe("escapeCommand", () => {
  it("escapes newlines and percent signs", () => {
    assert.equal(escapeCommand("50%\nnext"), "50%25%0Anext")
  })
})
