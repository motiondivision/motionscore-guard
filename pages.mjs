/* Prints the paths to audit, one per line. With an empty `pages` input it
 * audits "/" only: the same list then runs on main and on pull requests, so
 * the grades compare like with like.
 * Run as: node pages.mjs with PAGES, FLOOR and MAX_DROP in the env. */
import { parsePages, parsePolicy, ConfigError, escapeCommand } from "./lib.mjs"

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

const listed = parsePages(process.env.PAGES)
const pages = listed.length ? listed : ["/"]

process.stdout.write(`${pages.join("\n")}\n`)
