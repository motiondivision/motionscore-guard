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
permissions:
  id-token: write
  contents: read
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: motiondivision/motionscore-guard@v2
        with:
          pages: |
            /
            /pricing
```

There is no URL to set. Most hosts, such as Vercel and Netlify, emit the `deployment_status` event, and the action audits the deployment's own URL once it succeeds:

- **Preview deployments** check pull requests against the baseline.
- **Production deployments** of your default branch update the baseline. Motion checks with GitHub that the deployed commit is on the default branch, so a preview never becomes the baseline.
- **First run:** the first run on a repo saves the baseline, even when it is a pull request. A pull request never replaces an existing baseline.

`permissions: id-token: write` is required. Without it, the action cannot get an OIDC token and the job fails.

Deploy from your own CI? Run Guard after your deploy step and pass `url:`.

No preview deployments? Build and serve the site on the runner instead, and set `url` and `serve`:

```yaml
on:
  pull_request:
  push:
    branches: [main]
permissions:
  id-token: write
  contents: read
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build
      - uses: motiondivision/motionscore-guard@v2
        with:
          url: http://localhost:4173
          serve: npx --yes serve@14 -l 4173 dist
```

## Choose pages

List the pages with your key animations under `pages:`. Guard audits the same list on main and on pull requests, so the grades compare like with like. With no `pages:`, Guard audits / only.

For example:

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
| `url` | auto | Base URL to audit. Leave it empty on `deployment_status` workflows: Guard audits the deployment's own URL. Set it when you serve the site in CI |
| `pages` | `/` | Newline-separated paths to audit, relative to the deployment URL. Default: `/` |
| `floor` | `C` | The check fails if any page grades worse than this tier (S/A/B/C/D/F). `none` turns the floor off |
| `max-drop` | `1` | The largest drop in grades from the baseline that still passes the check |
| `serve` | none | Command that builds and serves the site before the audit, for example `npm run build && npx serve dist -l 4173` |
| `cli-version` | pinned | `motionscore` CLI version to run |
| `api-url` | `https://api.motion.dev` | Motion API base URL |

## Outputs

- `verdict`: `pass`, `fail`, `skipped` or `baseline` from Motion. When the run is not graded: `not_entitled`, `not_installed`, `unavailable` or `error`.
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
