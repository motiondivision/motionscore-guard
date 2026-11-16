/* Prints the paths to audit, one per line. With an empty `pages` input, it
 * reads <url>/sitemap.xml and picks "/" plus up to four short paths on the
 * same host. Any sitemap problem falls back to "/".
 * Run as: node pages.mjs with BASE_URL, PAGES, FLOOR and MAX_DROP in the env. */
import { parsePages, parsePolicy, pickSitemapPaths, ConfigError, escapeCommand } from "./lib.mjs"

const baseUrl = (process.env.BASE_URL ?? "").replace(/\/+$/, "")

// Check the policy inputs before any audit runs, so a typo fails fast.
try {
  parsePolicy(process.env.FLOOR, process.env.MAX_DROP)
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`::error::${escapeCommand(err.message)}`)
    process.exit(1)
  }
  throw err
}

let pages = parsePages(process.env.PAGES)

if (pages.length === 0) {
  pages = ["/"]
  try {
    const res = await fetch(`${baseUrl}/sitemap.xml`, { signal: AbortSignal.timeout(15000) })
    if (res.ok) {
      pages = pickSitemapPaths(await res.text(), baseUrl)
    } else {
      console.error(`No sitemap at ${baseUrl}/sitemap.xml (${res.status}). Auditing "/" only.`)
    }
  } catch (err) {
    console.error(`Could not read ${baseUrl}/sitemap.xml (${err.message}). Auditing "/" only.`)
  }
}

process.stdout.write(`${pages.join("\n")}\n`)
