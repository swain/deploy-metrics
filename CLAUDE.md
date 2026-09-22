# CLAUDE.md — deploy-metrics

Contributor throughput dashboard for the `thegoodparty` GitHub org.

## What this measures

Qualifying merged pull requests, and the lines of code inside them, per
contributor, per working day, across the org. Results are bucketed into ISO
weeks so the series is longitudinal — you can watch throughput trend week
over week, not just see a single snapshot.

The metric definitions (what counts as a qualifying PR, how lines are
counted, how working days are derived) live in
`docs/specs/2026-09-22-throughput-dashboard-design.md`. Those definitions
were validated against a published org report. Changing a threshold or a
path list in the code silently breaks that agreement — check the spec before
you touch classification logic.

## Viewing the dashboard

This repo is private, and GitHub Pages is off. Making the repo private
disabled Pages, because Pages from a private repo needs a paid GitHub plan.

So there's no hosted URL. View the dashboard as a local file:

```bash
npm run open
```

The page embeds its data directly in the HTML rather than fetching it at
load time. That's not a style choice — `fetch()` against a `file://` URL is
blocked by the browser, so a fetch-based page would just fail silently when
opened locally.

## Scripts

- `npm run collect` — fetches PR data from the GitHub API and aggregates it.
- `npm run render` — regenerates `index.html` from the template.
- `npm run build` — runs `collect` then `render`.
- `npm run open` — renders and opens the dashboard.
- `npm test` — runs the test suite.

`index.html` is **generated** from `dashboard.template.html`. Edit the
template, never `index.html` directly — your edits will be overwritten on
the next render.

## Data and caching

`data/history.json` holds the aggregated series. `data/weeks/` caches one
file per completed ISO week, fetched once from the GitHub API and never
refetched. The in-progress (current) week is not cached — it's refetched
every run, since it's still changing.

If you change the classifier (what counts as a qualifying PR, how lines are
counted), the cached weeks under `data/weeks/` still reflect the old rules.
**Delete `data/weeks/` and re-run `npm run build`** to rebuild the whole
history from scratch under the new rules. This is the only way to recover
from a classifier change, and it's why the classifier can be changed safely
at all — nothing about the cache design lets stale and fresh classifications
mix silently.

## Running nightly

`.github/workflows/update.yml` runs the collector nightly via
`workflow_dispatch`-capable cron, then commits the refreshed `data/` and
`index.html` back to the branch. It needs the `GH_PAT` secret, which must
have org read access to see PRs across all `thegoodparty` repos.

GitHub disables scheduled workflows after 60 days without any repository
activity. If the nightly job silently stops running, this is the first thing
to check — the workflow won't show as failing, because it never fires.
