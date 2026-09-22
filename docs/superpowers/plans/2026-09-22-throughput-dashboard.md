# Contributor Throughput Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dead MTTD dashboard with a nightly-updating, longitudinal view of qualifying throughput across the GoodParty GitHub org, total and per contributor.

**Architecture:** A nightly GitHub Action runs a TypeScript collector that fetches one GitHub search window per ISO week, writes a derived per-week cache under `data/weeks/`, aggregates every cached week into `data/history.json`, and injects that history into a committed `index.html`. Completed weeks are fetched once; the in-progress week is refetched every run. All classification logic is pure and unit-tested; only the network layer is not.

**Tech Stack:** Node 22, TypeScript via `tsx`, `@octokit/rest` (already dependencies), `node --test` for tests, hand-rolled inline SVG for charts (no chart library, no CDN).

**Spec:** `docs/specs/2026-09-22-throughput-dashboard-design.md`

## Global Constraints

- Repo is `swain/deploy-metrics`, private as of 2026-09-22. GitHub Pages is off. The dashboard is opened as a local file.
- The page must work from `file://`: data is **embedded** into `index.html`, never fetched. No CDN scripts, no external stylesheets, no network at view time.
- Never commit raw diffs or file lists. Only derived counts.
- Weeks are ISO weeks keyed `YYYY-Www`, bucketed in **UTC**.
- Backfill start: `2026-01-05` (the Monday of `2026-W02`).
- Org is `thegoodparty`. Auth for fetching is the existing `GH_PAT` repo secret.
- Exclusion rules and their names are fixed: `empty`, `promotion`, `revert`, `move`, `deps`, `generated`, `machine`.
- Machine-state detection threshold: at least **10** sole-file pull requests for that file, median sole size **<= 10** lines.
- Never a dual-axis chart. Lines and PR counts are separate stacked panels sharing one x-axis.
- Run tests with `node --import tsx --test test/*.test.ts`.
- Commit with `--no-verify`. No `Co-Authored-By` trailers.

---

### Task 1: Week and working-day utilities

**Files:**
- Create: `src/weeks.ts`
- Create: `test/weeks.test.ts`
- Create: `holidays.json`
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Consumes: nothing.
- Produces: `isoWeekKey(isoTimestamp: string): string`, `weekStartUTC(key: string): Date`, `weekWindow(key: string): { from: string; to: string }`, `weeksBetween(startKey: string, endKey: string): string[]`, `workingDays(key: string, holidays: Set<string>): number`.

- [ ] **Step 1: Write the failing test**

Create `test/weeks.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { isoWeekKey, weekWindow, weeksBetween, workingDays } from '../src/weeks.ts'

test('isoWeekKey buckets by UTC ISO week', () => {
  assert.equal(isoWeekKey('2026-01-05T12:00:00Z'), '2026-W02')
  assert.equal(isoWeekKey('2026-01-11T23:59:59Z'), '2026-W02')
  assert.equal(isoWeekKey('2026-01-12T00:00:00Z'), '2026-W03')
  assert.equal(isoWeekKey('2026-09-22T09:00:00Z'), '2026-W39')
})

test('isoWeekKey handles the year boundary by ISO rules', () => {
  assert.equal(isoWeekKey('2025-12-29T00:00:00Z'), '2026-W01')
  assert.equal(isoWeekKey('2026-01-01T00:00:00Z'), '2026-W01')
})

test('weekWindow returns the Monday..Sunday UTC dates', () => {
  assert.deepEqual(weekWindow('2026-W02'), { from: '2026-01-05', to: '2026-01-11' })
})

test('weeksBetween is inclusive and ordered', () => {
  assert.deepEqual(weeksBetween('2026-W02', '2026-W05'),
    ['2026-W02', '2026-W03', '2026-W04', '2026-W05'])
})

test('workingDays counts weekdays less holidays', () => {
  assert.equal(workingDays('2026-W02', new Set()), 5)
  assert.equal(workingDays('2026-W02', new Set(['2026-01-07'])), 4)
  assert.equal(workingDays('2026-W02', new Set(['2026-01-10'])), 5)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/weeks.test.ts`
Expected: FAIL, cannot find module `../src/weeks.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/weeks.ts`:

```ts
const DAY = 86_400_000

const pad = (n: number): string => String(n).padStart(2, '0')

const ymd = (d: Date): string =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`

const mondayOf = (d: Date): Date => {
  const offset = (d.getUTCDay() + 6) % 7
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset))
}

const week1Monday = (isoYear: number): Date =>
  mondayOf(new Date(Date.UTC(isoYear, 0, 4)))

export const isoWeekKey = (isoTimestamp: string): string => {
  const monday = mondayOf(new Date(isoTimestamp))
  const thursday = new Date(monday.getTime() + 3 * DAY)
  const isoYear = thursday.getUTCFullYear()
  const week = Math.round((monday.getTime() - week1Monday(isoYear).getTime()) / (7 * DAY)) + 1
  return `${isoYear}-W${pad(week)}`
}

export const weekStartUTC = (key: string): Date => {
  const [year, week] = key.split('-W').map(Number)
  return new Date(week1Monday(year).getTime() + (week - 1) * 7 * DAY)
}

export const weekWindow = (key: string): { from: string; to: string } => {
  const start = weekStartUTC(key)
  return { from: ymd(start), to: ymd(new Date(start.getTime() + 6 * DAY)) }
}

export const weeksBetween = (startKey: string, endKey: string): string[] => {
  const out: string[] = []
  const end = weekStartUTC(endKey).getTime()
  for (let t = weekStartUTC(startKey).getTime(); t <= end; t += 7 * DAY) {
    out.push(isoWeekKey(new Date(t).toISOString()))
  }
  return out
}

export const workingDays = (key: string, holidays: Set<string>): number => {
  const start = weekStartUTC(key)
  let n = 0
  for (let i = 0; i < 5; i++) {
    const d = new Date(start.getTime() + i * DAY)
    if (!holidays.has(ymd(d))) n++
  }
  return n
}
```

Create `holidays.json`:

```json
["2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-11-27", "2026-12-24", "2026-12-25"]
```

- [ ] **Step 4: Add the test script**

In `package.json`, replace the `test` script with:

```json
"test": "node --import tsx --test test/*.test.ts"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/weeks.ts test/weeks.test.ts holidays.json package.json
git commit --no-verify -m "Add UTC ISO-week bucketing and working-day counting"
```

---

### Task 2: Pull-request classification and machine-state detection

**Files:**
- Create: `src/classify.ts`
- Create: `test/classify.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: types `RawFile`, `RawPr`, `CachedPr`; `toCached(pr: RawPr): CachedPr`; `detectMachineState(rows: CachedPr[]): Set<string>`; `isQualifying(row: CachedPr, machine: Set<string>): boolean`; `machineKey(repo: string, path: string): string`.

This is the part that must match the parent report. Get it right here and everything downstream is arithmetic.

- [ ] **Step 1: Write the failing test**

Create `test/classify.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { toCached, detectMachineState, isQualifying, machineKey } from '../src/classify.ts'
import type { RawPr, RawFile } from '../src/classify.ts'

const file = (path: string, add = 5, del = 5, changeType = 'MODIFIED'): RawFile =>
  ({ path, additions: add, deletions: del, changeType })

const pr = (over: Partial<RawPr> = {}): RawPr => ({
  repo: 'omni', number: 1, title: 'feat: a thing', login: 'someone',
  mergedAt: '2026-01-06T10:00:00Z', baseRefName: 'main', headRefName: 'feat/x',
  additions: 5, deletions: 5, changedFiles: 1, files: [file('src/a.ts')], ...over,
})

test('a normal pull request qualifies with no reasons', () => {
  const row = toCached(pr())
  assert.deepEqual(row.reasons, [])
  assert.equal(row.qlocBase, 10)
  assert.equal(isQualifying(row, new Set()), true)
})

test('an empty diff is excluded', () => {
  assert.deepEqual(toCached(pr({ changedFiles: 0, files: [] })).reasons, ['empty'])
})

test('a promotion between two long-lived branches is excluded', () => {
  const row = toCached(pr({ baseRefName: 'master', headRefName: 'qa' }))
  assert.deepEqual(row.reasons, ['promotion'])
})

test('a feature branch into a long-lived branch is not a promotion', () => {
  assert.deepEqual(toCached(pr({ baseRefName: 'main', headRefName: 'qa-fixes' })).reasons, [])
})

test('a revert is excluded by title', () => {
  assert.deepEqual(toCached(pr({ title: 'Revert "feat: a thing"' })).reasons, ['revert'])
})

test('an all-rename diff is a pure move', () => {
  const files = [file('a.ts', 0, 0, 'RENAMED'), file('b.ts', 0, 0, 'RENAMED')]
  const row = toCached(pr({ files, changedFiles: 2 }))
  assert.deepEqual(row.reasons, ['move'])
})

test('a lockfile-and-manifest-only diff is dependency only', () => {
  const files = [file('package.json'), file('package-lock.json')]
  const row = toCached(pr({ files, changedFiles: 2 }))
  assert.deepEqual(row.reasons, ['deps'])
})

test('a build-output-only diff is generated only', () => {
  const row = toCached(pr({ files: [file('dist/bundle.js')], changedFiles: 1 }))
  assert.deepEqual(row.reasons, ['generated'])
})

test('qlocBase ignores lockfile, manifest and build lines but keeps source', () => {
  const files = [file('src/a.ts', 10, 2), file('package-lock.json', 900, 900), file('dist/x.js', 50, 0)]
  assert.equal(toCached(pr({ files, changedFiles: 3 })).qlocBase, 12)
})

test('sole-file fields are set only for single-file diffs', () => {
  const one = toCached(pr({ files: [file('state.json', 1, 1)], changedFiles: 1 }))
  assert.equal(one.soleFile, 'state.json')
  assert.equal(one.soleLines, 2)
  const two = toCached(pr({ files: [file('a.ts'), file('b.ts')], changedFiles: 2 }))
  assert.equal(two.soleFile, null)
  assert.equal(two.soleLines, null)
})

test('detectMachineState needs both repetition and triviality', () => {
  const sole = (path: string, n: number, lines: number): CachedPrLike[] =>
    Array.from({ length: n }, (_, i) =>
      toCached(pr({ number: i, files: [file(path, lines, 0)], changedFiles: 1 })))
  type CachedPrLike = ReturnType<typeof toCached>

  const rows = [
    ...sole('watcher/state.json', 12, 2),
    ...sole('rare/state.json', 9, 2),
    ...sole('big/report.md', 12, 400),
  ]
  const machine = detectMachineState(rows)
  assert.equal(machine.has(machineKey('omni', 'watcher/state.json')), true)
  assert.equal(machine.has(machineKey('omni', 'rare/state.json')), false)
  assert.equal(machine.has(machineKey('omni', 'big/report.md')), false)
})

test('a pull request whose whole diff is a state file does not qualify', () => {
  const row = toCached(pr({ files: [file('watcher/state.json', 1, 1)], changedFiles: 1 }))
  const machine = new Set([machineKey('omni', 'watcher/state.json')])
  assert.equal(isQualifying(row, machine), false)
  assert.equal(isQualifying(row, new Set()), true)
})

test('a real change that also touches a state file still qualifies', () => {
  const files = [file('src/a.ts', 10, 0), file('watcher/state.json', 1, 1)]
  const row = toCached(pr({ files, changedFiles: 2 }))
  assert.equal(isQualifying(row, new Set([machineKey('omni', 'watcher/state.json')])), true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/classify.test.ts`
Expected: FAIL, cannot find module `../src/classify.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/classify.ts`:

```ts
export interface RawFile {
  path: string
  additions: number
  deletions: number
  changeType: string
}

export interface RawPr {
  repo: string
  number: number
  title: string
  login: string
  mergedAt: string
  baseRefName: string
  headRefName: string
  additions: number
  deletions: number
  changedFiles: number
  files: RawFile[]
}

export interface CachedPr {
  repo: string
  number: number
  login: string
  mergedAt: string
  reasons: string[]
  qlocBase: number
  added: number
  deleted: number
  changedFiles: number
  soleFile: string | null
  soleLines: number | null
}

const LONG_LIVED = new Set([
  'main', 'master', 'develop', 'dev', 'qa', 'staging', 'stage', 'production', 'prod', 'release',
])

const LOCKFILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'uv.lock', 'poetry.lock',
  'Gemfile.lock', 'composer.lock', 'go.sum', 'Cargo.lock', 'Pipfile.lock',
  'bun.lockb', 'npm-shrinkwrap.json',
])

const MANIFESTS = new Set([
  'package.json', 'pyproject.toml', 'Gemfile', 'go.mod', 'Cargo.toml',
  'composer.json', 'Pipfile', 'requirements.txt', 'requirements-dev.txt',
  'setup.cfg', 'setup.py',
])

const BUILD_DIRS = [
  'dist/', 'build/', '.next/', 'out/', 'coverage/', 'node_modules/', 'generated/',
  '__generated__/', '.terraform/', 'target/', '.turbo/', '__snapshots__/',
]

const BUILD_SUFFIXES = ['.min.js', '.min.css', '.map', '.snap', '.lock']

const basename = (path: string): string => path.split('/').pop() ?? path

const isLock = (path: string): boolean => LOCKFILES.has(basename(path))
const isManifest = (path: string): boolean => MANIFESTS.has(basename(path))

const isBuild = (path: string): boolean => {
  const probe = `/${path}`
  return BUILD_DIRS.some((d) => probe.includes(`/${d}`)) ||
    BUILD_SUFFIXES.some((s) => path.endsWith(s))
}

const countsTowardLines = (path: string): boolean =>
  !isLock(path) && !isManifest(path) && !isBuild(path)

export const machineKey = (repo: string, path: string): string => `${repo}/${path}`

export const toCached = (pr: RawPr): CachedPr => {
  const files = pr.files ?? []
  const reasons: string[] = []

  if (pr.changedFiles === 0 || files.length === 0) reasons.push('empty')
  if (LONG_LIVED.has(pr.baseRefName) && LONG_LIVED.has(pr.headRefName)) reasons.push('promotion')
  if (pr.title.trim().toLowerCase().startsWith('revert')) reasons.push('revert')

  if (files.length > 0) {
    if (files.every((f) => f.changeType === 'RENAMED')) reasons.push('move')
    if (files.every((f) => isLock(f.path) || isManifest(f.path))) reasons.push('deps')
    if (files.every((f) => isBuild(f.path))) reasons.push('generated')
  }

  const qlocBase = files
    .filter((f) => countsTowardLines(f.path))
    .reduce((sum, f) => sum + f.additions + f.deletions, 0)

  const sole = pr.changedFiles === 1 && files.length === 1 ? files[0] : null

  return {
    repo: pr.repo,
    number: pr.number,
    login: pr.login,
    mergedAt: pr.mergedAt,
    reasons,
    qlocBase,
    added: pr.additions,
    deleted: pr.deletions,
    changedFiles: pr.changedFiles,
    soleFile: sole ? sole.path : null,
    soleLines: sole ? sole.additions + sole.deletions : null,
  }
}

const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export const MACHINE_MIN_PRS = 10
export const MACHINE_MAX_MEDIAN_LINES = 10

export const detectMachineState = (rows: CachedPr[]): Set<string> => {
  const sizes = new Map<string, number[]>()
  for (const row of rows) {
    if (row.soleFile === null || row.soleLines === null) continue
    const key = machineKey(row.repo, row.soleFile)
    const list = sizes.get(key)
    if (list) list.push(row.soleLines)
    else sizes.set(key, [row.soleLines])
  }
  const machine = new Set<string>()
  for (const [key, list] of sizes) {
    if (list.length >= MACHINE_MIN_PRS && median(list) <= MACHINE_MAX_MEDIAN_LINES) {
      machine.add(key)
    }
  }
  return machine
}

export const isQualifying = (row: CachedPr, machine: Set<string>): boolean => {
  if (row.reasons.length > 0) return false
  if (row.soleFile !== null && machine.has(machineKey(row.repo, row.soleFile))) return false
  return true
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all classify tests plus the week tests.

- [ ] **Step 5: Commit**

```bash
git add src/classify.ts test/classify.test.ts
git commit --no-verify -m "Add pull-request classification and derived machine-state detection"
```

---

### Task 3: Aggregation into the history series

**Files:**
- Create: `src/aggregate.ts`
- Create: `test/aggregate.test.ts`

**Interfaces:**
- Consumes: `CachedPr`, `detectMachineState`, `isQualifying` from `src/classify.ts`; `workingDays` from `src/weeks.ts`.
- Produces: types `ContributorWeek`, `WeekSummary`, `History`; `buildHistory(weeks: Map<string, CachedPr[]>, holidays: Set<string>, options: { bots: Set<string>; generatedAt: string }): History`.

- [ ] **Step 1: Write the failing test**

Create `test/aggregate.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHistory } from '../src/aggregate.ts'
import { toCached } from '../src/classify.ts'
import type { RawPr } from '../src/classify.ts'

const pr = (over: Partial<RawPr> = {}): RawPr => ({
  repo: 'omni', number: 1, title: 'feat: x', login: 'alice',
  mergedAt: '2026-01-06T10:00:00Z', baseRefName: 'main', headRefName: 'feat/x',
  additions: 60, deletions: 40, changedFiles: 1,
  files: [{ path: 'src/a.ts', additions: 60, deletions: 40, changeType: 'MODIFIED' }], ...over,
})

const opts = { bots: new Set(['robot']), generatedAt: '2026-09-22T00:00:00Z' }

test('per-contributor rates divide by that week working days', () => {
  const weeks = new Map([['2026-W02', [toCached(pr())]]])
  const h = buildHistory(weeks, new Set(), opts)
  const week = h.weeks[0]
  assert.equal(week.week, '2026-W02')
  assert.equal(week.workingDays, 5)
  assert.equal(week.totals.lines, 100)
  assert.equal(week.totals.prs, 1)
  assert.equal(week.contributors[0].login, 'alice')
  assert.equal(week.contributors[0].lines, 100)
})

test('a holiday shortens the denominator, not the totals', () => {
  const weeks = new Map([['2026-W02', [toCached(pr())]]])
  const h = buildHistory(weeks, new Set(['2026-01-07']), opts)
  assert.equal(h.weeks[0].workingDays, 4)
  assert.equal(h.weeks[0].totals.lines, 100)
})

test('excluded pull requests contribute nothing', () => {
  const weeks = new Map([['2026-W02', [
    toCached(pr()),
    toCached(pr({ number: 2, baseRefName: 'master', headRefName: 'qa' })),
  ]]])
  const h = buildHistory(weeks, new Set(), opts)
  assert.equal(h.weeks[0].totals.prs, 1)
  assert.equal(h.weeks[0].totals.lines, 100)
})

test('bots are held out of totals and reported separately', () => {
  const weeks = new Map([['2026-W02', [toCached(pr()), toCached(pr({ number: 2, login: 'robot' }))]]])
  const h = buildHistory(weeks, new Set(), opts)
  assert.equal(h.weeks[0].totals.prs, 1)
  assert.deepEqual(h.weeks[0].contributors.map((c) => c.login), ['alice'])
  assert.equal(h.bots.robot.prs, 1)
})

test('weeks come out in chronological order and carry the contributor index', () => {
  const weeks = new Map([
    ['2026-W03', [toCached(pr({ mergedAt: '2026-01-13T10:00:00Z', login: 'bob' }))]],
    ['2026-W02', [toCached(pr())]],
  ])
  const h = buildHistory(weeks, new Set(), opts)
  assert.deepEqual(h.weeks.map((w) => w.week), ['2026-W02', '2026-W03'])
  assert.deepEqual([...h.contributors].sort(), ['alice', 'bob'])
  assert.equal(h.generatedAt, '2026-09-22T00:00:00Z')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/aggregate.test.ts`
Expected: FAIL, cannot find module `../src/aggregate.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/aggregate.ts`:

```ts
import { detectMachineState, isQualifying } from './classify.ts'
import type { CachedPr } from './classify.ts'
import { workingDays } from './weeks.ts'

export interface ContributorWeek {
  login: string
  prs: number
  lines: number
  added: number
  deleted: number
}

export interface WeekSummary {
  week: string
  workingDays: number
  totals: { prs: number; lines: number; added: number; deleted: number; people: number }
  contributors: ContributorWeek[]
}

export interface History {
  generatedAt: string
  contributors: string[]
  weeks: WeekSummary[]
  bots: Record<string, { prs: number; lines: number }>
  machineStateFiles: string[]
}

const blank = (login: string): ContributorWeek =>
  ({ login, prs: 0, lines: 0, added: 0, deleted: 0 })

export const buildHistory = (
  weeks: Map<string, CachedPr[]>,
  holidays: Set<string>,
  options: { bots: Set<string>; generatedAt: string },
): History => {
  const all = [...weeks.values()].flat()
  const machine = detectMachineState(all)

  const bots: Record<string, { prs: number; lines: number }> = {}
  const people = new Set<string>()
  const summaries: WeekSummary[] = []

  for (const key of [...weeks.keys()].sort()) {
    const rows = (weeks.get(key) ?? []).filter((r) => isQualifying(r, machine))
    const byLogin = new Map<string, ContributorWeek>()

    for (const row of rows) {
      if (options.bots.has(row.login)) {
        const bot = bots[row.login] ?? { prs: 0, lines: 0 }
        bot.prs += 1
        bot.lines += row.qlocBase
        bots[row.login] = bot
        continue
      }
      const entry = byLogin.get(row.login) ?? blank(row.login)
      entry.prs += 1
      entry.lines += row.qlocBase
      entry.added += row.added
      entry.deleted += row.deleted
      byLogin.set(row.login, entry)
      people.add(row.login)
    }

    const contributors = [...byLogin.values()].sort((a, b) => b.lines - a.lines)
    summaries.push({
      week: key,
      workingDays: workingDays(key, holidays),
      totals: {
        prs: contributors.reduce((n, c) => n + c.prs, 0),
        lines: contributors.reduce((n, c) => n + c.lines, 0),
        added: contributors.reduce((n, c) => n + c.added, 0),
        deleted: contributors.reduce((n, c) => n + c.deleted, 0),
        people: contributors.length,
      },
      contributors,
    })
  }

  return {
    generatedAt: options.generatedAt,
    contributors: [...people].sort(),
    weeks: summaries,
    bots,
    machineStateFiles: [...machine].sort(),
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/aggregate.ts test/aggregate.test.ts
git commit --no-verify -m "Aggregate cached weeks into the history series"
```

---

### Task 4: GitHub fetch layer

**Files:**
- Create: `src/github.ts`

**Interfaces:**
- Consumes: `RawPr`, `RawFile` types from `src/classify.ts`.
- Produces: `fetchWeek(window: { from: string; to: string }, token: string): Promise<RawPr[]>`.

Not unit-tested; it is the network boundary. It is exercised by the smoke run in Task 5.

- [ ] **Step 1: Write the implementation**

Create `src/github.ts`:

```ts
import type { RawPr, RawFile } from './classify.ts'

const ENDPOINT = 'https://api.github.com/graphql'
const ORG = 'thegoodparty'

const SEARCH = `
query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 20, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title mergedAt baseRefName headRefName additions deletions changedFiles
      author { login }
      repository { name }
      files(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes { path additions deletions changeType }
      }
    } }
  }
}`

const FILES = `
query($repo: String!, $number: Int!, $after: String) {
  repository(owner: "${ORG}", name: $repo) {
    pullRequest(number: $number) {
      files(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { path additions deletions changeType }
      }
    }
  }
}`

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const gql = async (query: string, variables: Record<string, unknown>, token: string): Promise<any> => {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      })
      if (!res.ok) {
        if ([429, 500, 502, 503].includes(res.status)) { await sleep(5000 * (attempt + 1)); continue }
        throw new Error(`GitHub HTTP ${res.status}`)
      }
      const body = await res.json()
      if (body.errors && !body.data) {
        const message = JSON.stringify(body.errors).slice(0, 200)
        if (message.includes('RATE_LIMITED')) { await sleep(30_000); continue }
        throw new Error(`GitHub GraphQL: ${message}`)
      }
      return body.data
    } catch (error) {
      if (attempt === 5) throw error
      await sleep(5000 * (attempt + 1))
    }
  }
  throw new Error('unreachable')
}

const pageFiles = async (repo: string, number: number, after: string, token: string): Promise<RawFile[]> => {
  const out: RawFile[] = []
  let cursor: string | null = after
  for (let guard = 0; guard < 60 && cursor; guard++) {
    const data = await gql(FILES, { repo, number, after: cursor }, token)
    const files = data.repository.pullRequest.files
    out.push(...files.nodes)
    cursor = files.pageInfo.hasNextPage ? files.pageInfo.endCursor : null
  }
  return out
}

export const fetchWeek = async (
  window: { from: string; to: string },
  token: string,
): Promise<RawPr[]> => {
  const q = `org:${ORG} is:pr is:merged merged:${window.from}..${window.to} sort:created-asc`
  const out: RawPr[] = []
  let after: string | null = null

  for (;;) {
    const data = await gql(SEARCH, { q, after }, token)
    const search = data.search
    if (search.issueCount >= 1000) {
      throw new Error(`week ${window.from} hit the 1000-result search cap; narrow the window`)
    }
    for (const node of search.nodes) {
      if (!node || !node.mergedAt) continue
      const files: RawFile[] = [...node.files.nodes]
      if (node.files.pageInfo.hasNextPage) {
        files.push(...await pageFiles(node.repository.name, node.number, node.files.pageInfo.endCursor, token))
      }
      out.push({
        repo: node.repository.name,
        number: node.number,
        title: node.title,
        login: node.author?.login ?? '(ghost)',
        mergedAt: node.mergedAt,
        baseRefName: node.baseRefName,
        headRefName: node.headRefName,
        additions: node.additions,
        deletions: node.deletions,
        changedFiles: node.changedFiles,
        files,
      })
    }
    if (!search.pageInfo.hasNextPage) break
    after = search.pageInfo.endCursor
  }
  return out
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit --skipLibCheck --allowImportingTsExtensions --module esnext --moduleResolution bundler --target es2022 --strict src/github.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/github.ts
git commit --no-verify -m "Add the GitHub weekly search and file-paging layer"
```

---

### Task 5: The collector entry point

**Files:**
- Create: `src/collect.ts`
- Delete: `update.ts`
- Delete: `metrics.json`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `fetchWeek`, `toCached`, `buildHistory`, `weeksBetween`, `weekWindow`, `isoWeekKey`.
- Produces: the CLI `npm run collect`. Writes `data/weeks/<key>.json` and `data/history.json`.

- [ ] **Step 1: Write the implementation**

Create `src/collect.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fetchWeek } from './github.ts'
import { toCached } from './classify.ts'
import type { CachedPr } from './classify.ts'
import { buildHistory } from './aggregate.ts'
import { isoWeekKey, weekWindow, weeksBetween } from './weeks.ts'

const START_WEEK = '2026-W02'
const BOTS = new Set(['omni-automaton', 'delegate-gp', 'dependabot', 'github-actions', 'claude'])
const WEEKS_DIR = 'data/weeks'

const token = process.env.GH_TOKEN
if (!token) {
  console.error('GH_TOKEN is required')
  process.exit(1)
}

const currentWeek = isoWeekKey(new Date().toISOString())
const wanted = weeksBetween(START_WEEK, currentWeek)
mkdirSync(WEEKS_DIR, { recursive: true })

for (const key of wanted) {
  const path = join(WEEKS_DIR, `${key}.json`)
  // A finished week never changes, so it is fetched once. The current week is
  // always refetched, because it is still filling up.
  if (existsSync(path) && key !== currentWeek) continue
  const rows = (await fetchWeek(weekWindow(key), token)).map(toCached)
  // Write only on success: a partial file would be cached as if it were whole.
  writeFileSync(path, JSON.stringify(rows))
  console.log(`${key}: ${rows.length} merged pull requests`)
}

const weeks = new Map<string, CachedPr[]>()
for (const file of readdirSync(WEEKS_DIR).filter((f) => f.endsWith('.json')).sort()) {
  weeks.set(file.replace('.json', ''), JSON.parse(readFileSync(join(WEEKS_DIR, file), 'utf8')))
}

const holidays = new Set<string>(JSON.parse(readFileSync('holidays.json', 'utf8')))
const history = buildHistory(weeks, holidays, { bots: BOTS, generatedAt: new Date().toISOString() })

writeFileSync('data/history.json', JSON.stringify(history, null, 1))
console.log(`history: ${history.weeks.length} weeks, ${history.contributors.length} contributors`)
console.log(`machine-state files: ${history.machineStateFiles.length}`)
```

- [ ] **Step 2: Remove the dead MTTD collector**

```bash
git rm update.ts metrics.json
```

- [ ] **Step 3: Update package.json scripts**

Replace the `scripts` block with:

```json
"scripts": {
  "collect": "tsx src/collect.ts",
  "render": "tsx src/render.ts",
  "build": "npm run collect && npm run render",
  "open": "npm run render && open index.html",
  "test": "node --import tsx --test test/*.test.ts"
}
```

- [ ] **Step 4: Smoke-run a single week against the real API**

Temporarily set `START_WEEK` to the current week, then run:

```bash
GH_TOKEN=$(gh auth token) npm run collect
```

Expected: one `data/weeks/<current>.json` written, a non-zero pull-request count, and a `history:` line. Then restore `START_WEEK` to `'2026-W02'`. Do not commit the smoke data.

- [ ] **Step 5: Commit**

```bash
git add src/collect.ts package.json
git commit --no-verify -m "Add the collector and retire the MTTD script"
```

---

### Task 6: The dashboard

**Files:**
- Create: `dashboard.template.html`
- Create: `src/render.ts`
- Modify: `index.html` (becomes generated output)
- Create: `.gitignore` entry check

**Interfaces:**
- Consumes: `data/history.json`.
- Produces: `index.html` with the history embedded at the `/*__DATA__*/` marker.

- [ ] **Step 1: Write the template**

Create `dashboard.template.html`. It must contain the literal marker `/*__DATA__*/` inside a script tag, hand-rolled SVG charts, no external requests, and a staleness banner. Structure:

- `<title>Throughput</title>`, system font stack, CSS custom properties for light and dark under `:root`, `@media (prefers-color-scheme: dark)`.
- A header with the current org headline numbers and a `#stale` banner, hidden unless `Date.now() - generatedAt > 48h`.
- Two `<svg>` panels, `#lines` and `#prs`, each ~920x220 viewBox, width 100%, sharing the same week x-positions. Panel titles "Qualifying lines per working day" and "Qualifying pull requests per working day".
- A `<div id="people">` list of contributor chips, each `<button data-login="...">` showing login and total lines.
- Script: `const HISTORY = /*__DATA__*/;` then render functions. Clicking a chip sets `selected` and redraws both panels for that login with the org median drawn as a faint reference line; clicking the active chip clears back to org totals. Keyboard accessible, `aria-pressed` on the buttons.
- Rates are `value / workingDays` for the selected series.

- [ ] **Step 2: Write the renderer**

Create `src/render.ts`:

```ts
import { readFileSync, writeFileSync } from 'node:fs'

const template = readFileSync('dashboard.template.html', 'utf8')
const history = readFileSync('data/history.json', 'utf8')

if (!template.includes('/*__DATA__*/')) {
  throw new Error('dashboard.template.html is missing the /*__DATA__*/ marker')
}

writeFileSync('index.html', template.replace('/*__DATA__*/', history))
console.log(`index.html written, ${history.length} bytes of data embedded`)
```

- [ ] **Step 3: Render and look at it**

```bash
npm run render && open index.html
```

Expected: both panels draw, clicking a contributor filters them, clicking again clears, no console errors, no network requests in the Network tab.

- [ ] **Step 4: Commit**

```bash
git add dashboard.template.html src/render.ts index.html
git commit --no-verify -m "Add the throughput dashboard and its renderer"
```

---

### Task 7: Nightly workflow and documentation

**Files:**
- Modify: `.github/workflows/update.yml`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a nightly run that commits `data/` and `index.html`.

- [ ] **Step 1: Replace the workflow**

Overwrite `.github/workflows/update.yml`:

```yaml
name: Update throughput

on:
  schedule:
    - cron: "0 22 * * *"
  workflow_dispatch: {}

concurrency:
  group: update-throughput
  cancel-in-progress: false

permissions:
  contents: write

jobs:
  update:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci

      - run: npm test

      - run: npm run build
        env:
          GH_TOKEN: ${{ secrets.GH_PAT }}

      - name: Commit refreshed data
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add data index.html
          git diff --cached --quiet && echo "no change" && exit 0
          git commit -m "Refresh throughput data"
          git push
```

- [ ] **Step 2: Rewrite CLAUDE.md**

Replace the whole file with a description of the throughput dashboard: what it measures, that the repo is private and Pages is off so `npm run open` is how you view it, where the spec lives, the week-cache invalidation rule (delete `data/weeks/` to rebuild), and the fact that `index.html` is generated from `dashboard.template.html`.

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/update.yml CLAUDE.md
git commit --no-verify -m "Run the throughput collector nightly and document it"
git push
```

- [ ] **Step 4: Trigger the backfill**

```bash
gh workflow run "Update throughput" --repo swain/deploy-metrics
gh run watch --repo swain/deploy-metrics
```

Expected: roughly 25 minutes on the cold run, a commit touching `data/weeks/*` and `data/history.json`, and a green result.

- [ ] **Step 5: Verify the result**

```bash
git pull && npm run open
```

Expected: a series running from 2026-W02 to the current week, no staleness banner, contributor chips populated, and `data/history.json` listing the expected machine-state files.
