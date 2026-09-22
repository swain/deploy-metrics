# Contributor throughput dashboard

Replaces the MTTD dashboard in this repo. Status: approved 2026-09-22.

## Why

A longitudinal view of engineering throughput across the GoodParty GitHub org,
for total output and per contributor, that keeps updating without being asked.

It descends from a one-shot report that counted qualifying merged pull requests
per working day over a fixed quarter. That report was a snapshot and could not
answer "is this changing". This one buckets by ISO week and keeps every week, so
the series is the point and any single week is not.

The MTTD dashboard it replaces has failed on every nightly run since at least
25 August 2026 and its newest data point is February 2026. It measured
`develop` to `master` promotions in gp-webapp, gp-api, people-api and
election-api. Omni absorbed those repos and runs a single `main` with an
automated release train, so there is no `master` to promote to. The metric is
structurally dead, not merely stale.

## Audience and exposure

A private instrument for one reader. The repo is private as of 2026-09-22.
Making it private switched GitHub Pages off, because Pages from a private repo
requires Pro or above; the dashboard is therefore opened as a local file.
Nothing in the design depends on hosting: `index.html` reads a sibling JSON, so
if Pages is ever re-enabled the same file serves unchanged.

The data names individual colleagues by GitHub login. It stays in a private
repo. It is not posted to Slack, not shared, and not used to evaluate anyone.

## Non-goals

- No scoring, ranking or z-scores. The parent report's robust log z existed to
  compare people at one instant. Here the unit of interest is a trend line, and
  a rank recomputed nightly would churn.
- No per-file or per-diff storage. Only derived counts are committed.
- No attempt to measure difficulty, review, design, incident response, or work
  outside this org.

## Data source and auth

GitHub GraphQL, `search(type: ISSUE)` over
`org:thegoodparty is:pr is:merged merged:<from>..<to>`, one query window per ISO
week. Search caps at 1,000 results however it is paged, and a week has never
approached that, so one week is always one complete window.

Auth is the existing `GH_PAT` repository secret, which already reads the org.
Cost is roughly 17 rate-limit points per week fetched, against 5,000 per hour.

## Metric definitions

Ported verbatim from the parent report and validated against its published
figures: the same six machine-state files with the same counts, 764 machine-state
exclusions, and per-person pull-request totals within a few of its own.

A pull request **qualifies** if it changed at least one file that is not build
output, not a lockfile or manifest, and not machine-written state. Nothing looks
at who or what opened it, so agent-authored and hand-authored changes count
alike.

Exclusion rules, any of which disqualifies a pull request:

| Rule | Test |
| --- | --- |
| Empty | no changed files |
| Branch promotion | base and head are both long-lived branches |
| Revert | title begins `revert` |
| Pure move | every file is a rename |
| Dependency only | every file is a lockfile or manifest |
| Generated only | every file is build output |
| Machine state | every file is a detected state file |

**Machine state is derived, not listed.** A file that is repeatedly the entire
diff of a pull request, at trivial size, is a program recording where it got to.
Detection: at least 10 pull requests where the file is the sole change, and a
median size of 10 lines or fewer, computed across the whole history.

**Qualifying lines** are additions plus deletions over the files in a qualifying
pull request that are not lockfiles, manifests, build output or machine state.
A lockfile bump inside a real change still contributes nothing.

Branch promotions matter more to a line count than to a pull-request count: they
are about 44% of every line changed in the org, because a develop-to-qa merge
re-carries lines that already arrived in the pull requests that fed it.

## Data model

Two committed shapes, both derived. No file lists are ever stored.

### `data/weeks/<iso-week>.json`: the fetch cache

One file per ISO week, one row per merged pull request:

```
{ repo, number, login, mergedAt, reasons[], qlocBase, added, deleted,
  changedFiles, soleFile, soleLines }
```

The cache holds only the part of the verdict a single week can decide.
`reasons` carries every exclusion except machine state, and `qlocBase` is the
line count over files that are not lockfiles, manifests or build output.

`soleFile` and `soleLines` are populated only when the pull request changed
exactly one file. They are what lets global machine-state detection run across
all weeks without refetching any diffs, which is the one piece of the
classification that cannot be decided from a single week in isolation.

Finishing the verdict at aggregate time is then a lookup, not a recount:

```
qualifying = reasons.length === 0 && !(soleFile && machineSet.has(soleFile))
qloc       = qlocBase
```

`qloc` needs no machine-state subtraction, because a state file only ever
affects the verdict when it is the entire diff, and in that case the whole pull
request is already excluded. A pull request that merely touches a state file
alongside real work keeps its lines, which are trivial by construction.

Roughly 2 MB for a year at current volume.

### `data/history.json`: what the page reads

Per ISO week: the working-day denominator, whether the week is still in
progress, org totals, and an array of per-contributor rows carrying qualifying
pull requests, qualifying lines, additions and deletions. Plus, at top level,
`generatedAt`, the sorted contributor index, the per-bot totals held out of the
org figures, and `machineStateFiles`.

`machineStateFiles` is the one place a file path is committed, and it is a
deliberate exception to "no file lists are stored". Machine state is derived
rather than enumerated, so without the resulting list the rule cannot be
audited: there is no way to see what the detector caught, or to notice it
catching something hand-maintained. The paths are bot state files and CI
configuration, never attributed to a contributor.

## Aggregation

- Weeks are ISO weeks, keyed `YYYY-Www`, attributed by merge date in **UTC**.
  UTC rather than Eastern so that the bucket boundary and the GitHub query
  window are the same instant. Under a local-time bucket, a pull request merged
  Sunday evening Eastern falls in Monday's UTC query window but Sunday's local
  bucket, which silently drops or duplicates it at every week boundary.
- The denominator is that week's weekdays less any holiday in a checked-in
  `holidays.json`, so a short week is not read as a slow one.
- Bot accounts are held out of the org totals and reported separately. There is
  no per-contributor volume floor: the parent report needed one to form a
  comparable cohort at a single instant, but in a weekly series a light week is
  a data point, not noise to be filtered.

## Refresh

A completed week is fetched once and cached. The in-progress week is refetched
on every run. Deleting `data/weeks/` rebuilds everything from scratch, which is
what makes a bug fix in the classifier a re-run rather than a migration.

Nightly on the existing cron. The first run backfills from 2026-01-05, about
38 weeks, and takes roughly 25 minutes; subsequent runs take seconds.

## Dashboard

`dashboard.template.html` is the editable source; the run writes `index.html`
with the data injected in place of a `/*__DATA__*/` marker. Both are committed.

The data is **embedded rather than fetched**, because `fetch()` against a
`file://` URL is blocked, and this dashboard is opened as a local file now that
Pages is off. Embedding means double-clicking the file works, offline, with no
server and no CDN. Charts are hand-rolled inline SVG for the same reason.

Two panels stacked on one shared x-axis: qualifying lines per working day, and
qualifying pull requests per working day. Never a dual axis. The two measures
have unrelated scales, and overlaying them invents a correlation.

Below the panels, the contributor list. Clicking a contributor filters both
panels to that person, drawn against a faint org-median band for context.
Clicking again clears back to the org total. That is the entire interaction.

## Failure handling

The dashboard it replaces rotted for seven months behind a nightly red X and a
page that still rendered. So:

- `generatedAt` is written on every run, and the page shows a visible staleness
  banner when the data is more than 48 hours old. The page cannot look healthy
  while the job is dead.
- A week that fails to fetch writes no file at all rather than a partial one, so
  the next run retries it.

## Testing

`node --test`, over the pure functions only: classification, machine-state
detection, ISO-week bucketing, working-day counting. Seeded with figures already
validated against the parent report, including the 764 machine-state exclusions
and the six known state files. The network layer is not tested.

## Risks

- **A login is not a person.** Accounts are reported as the API returns them.
  Someone who changes handle appears as two contributors.
- **Verbosity scores.** Eight hundred lines where eighty would do reads as more
  throughput. The line panel sits beside the count panel partly for this reason.
- **Deletion counts as production.** Additions and deletions are summed, so
  retiring a subsystem looks like building one.
- **One large import can swamp a week.** A cross-repo relocation arrives as
  pure additions and no rename filter catches it, because the files came from a
  different repository.
- **A week could exceed the search cap.** `search(type: ISSUE)` returns at most
  1,000 results however it is paged, and the collector throws rather than
  accepting a capped page. At 2026 volume a week is around 240 merges, so the
  ceiling is several years out at current growth, but it is a hard stop when it
  arrives: every nightly run aborts at the same week until the window is split.
  The remedy is to fetch that week as two windows (Monday to Wednesday, Thursday
  to Sunday) and concatenate, which the cache format already tolerates because a
  week file is just an array of rows.
