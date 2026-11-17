[![MotionScore](https://images.motion.dev/og/fresh/v1/score/home-25grdau0grse0.png)](https://motion.dev/dashboard/guard)

# Motion Performance Guard

Catch animation performance regressions before they merge. Motion Performance Guard audits your pages on every pull request, compares them with your main-branch baseline, and reports the result as a required check.

Motion Performance Guard is part of [Motion Cloud](https://motion.dev/dashboard/guard?utm_source=github&utm_medium=guard-readme).

## How it works

1. The action audits each page on your own runner with the [`motionscore`](https://www.npmjs.com/package/motionscore) CLI. It grades each page S to F for compositor, paint and layout cost, scroll animations, layout thrashing and GPU pressure.
2. The action sends the results to Motion. It signs in with GitHub's OIDC token, so there is no API token to store.
3. Motion compares the results with the baseline from your default branch. The Motion Performance app then posts a PR comment and a check run named **Motion Performance Guard**.

The action does not post comments and does not fail your job on the verdict. The check run is the gate. To block merges, make **Motion Performance Guard** a required check in your branch protection rules.

## Setup

1. Subscribe to [Motion Cloud](https://motion.dev/dashboard/guard?utm_source=github&utm_medium=guard-readme).
2. Install the Motion Performance app on your repository from the [Guard dashboard](https://motion.dev/dashboard/guard?utm_source=github&utm_medium=guard-readme).
3. Create `.github/workflows/motion-performance-guard.yml`:

```yaml
name: Motion Performance Guard
on:
  deployment_status:
  push:
    branches: [main]
permissions:
  id-token: write
  contents: read
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: motiondivision/motionscore-guard@v2
        with:
          url: ${{ github.event_name == 'push' && 'https://your-production-site.com' || '' }}
```

Replace `https://your-production-site.com` with your production URL.

- **Pull requests:** Vercel, Cloudflare Pages and Netlify emit the `deployment_status` event with the preview URL. The action reads the URL from the event. It waits until the deployment succeeds, then audits the preview.
- **Baseline:** a push to your default branch has no preview URL, so the `url` input gives your production URL. Runs on the default branch become the baseline that pull requests are compared with. Scheduled and manual runs on the default branch are baselines too. Deployments are never baselines.

`permissions: id-token: write` is required. Without it, the action cannot get an OIDC token and the job fails.

If you prefer, put the push case in a separate job:

```yaml
jobs:
  preview:
    if: github.event_name == 'deployment_status'
    runs-on: ubuntu-latest
    steps:
      - uses: motiondivision/motionscore-guard@v2
  baseline:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: motiondivision/motionscore-guard@v2
        with:
          url: https://your-production-site.com
```

## Choose pages

By default, the action audits `/` and up to four more paths from `<url>/sitemap.xml`. It picks paths on the same host as `url`, shortest first. If there is no sitemap, it audits `/` only.

To choose the pages yourself:

```yaml
      - uses: motiondivision/motionscore-guard@v2
        with:
          pages: |
            /
            /pricing
            /blog
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `url` | auto | Base URL to audit. Defaults to the preview URL on the `deployment_status` event. Required on `push` events |
| `pages` | auto | Newline-separated paths, relative to `url`. Empty means `/` plus up to four paths from the sitemap |
| `floor` | `C` | The check fails if any page grades worse than this tier (S/A/B/C/D/F). `none` turns the floor off |
| `max-drop` | `1` | The largest drop in grades from the baseline that still passes the check |
| `serve` | none | Command that builds and serves the site before the audit, for example `npm run build && npx serve dist -l 4173` |
| `cli-version` | pinned | `motionscore` CLI version to run |
| `api-url` | `https://api.motion.dev` | Motion API base URL |

## Outputs

- `verdict`: `pass`, `fail`, `waived` or `baseline` from Motion. When the run is not graded: `not_entitled`, `not_installed`, `unavailable` or `error`.
- `check-url`: the URL of the check run, when Motion created one.

## Exit codes

The job passes for every verdict, including `fail`. Use the check run to block merges.

| Situation | Result |
| --- | --- |
| Motion graded the run | Exit `0`. The step summary shows the verdict and links |
| No Motion Cloud plan, or the GitHub App is not installed | Exit `0` with a warning and a setup link |
| The Motion API cannot be reached, or has an error | Exit `0` with a warning. The run is not graded |
| `permissions: id-token: write` is missing | Exit `1` |
| Motion rejected the request for another reason | Exit `1` |
| No URL, or a bad `floor` or `max-drop` value | Exit `1` |

## Guard v1

`motiondivision/motionscore-guard@v1` is the earlier, free version. It posts a grades comment from your runner and does not compare with a baseline. It keeps working, but new features go to v2.
