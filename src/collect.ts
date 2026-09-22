import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { fetchWeek } from './github.ts'
import { toCached } from './classify.ts'
import type { CachedPr } from './classify.ts'
import { buildHistory } from './aggregate.ts'
import { isoWeekKey, weekWindow, weeksBetween } from './weeks.ts'

const START_WEEK = '2026-W02'
const BOTS = new Set(['omni-automaton', 'delegate-gp', 'dependabot', 'github-actions', 'claude', 'gp-sdk-release-bot', 'linter-pm'])
const WEEKS_DIR = 'data/weeks'

const token = process.env.GH_TOKEN
if (!token) {
  console.error('GH_TOKEN is required')
  process.exit(1)
}

const currentWeek = isoWeekKey(new Date().toISOString())
const wanted = weeksBetween(START_WEEK, currentWeek)
mkdirSync(WEEKS_DIR, { recursive: true })

// The last time a week is fetched as "current" is Sunday 22:00 UTC, two hours
// before the ISO week closes, so a merge in that window is never seen as
// current and would otherwise be skipped forever once the file exists. Treat
// the two most recent weeks as unsettled so both get refetched.
const unsettled = new Set(wanted.slice(-2))

for (const key of wanted) {
  const path = join(WEEKS_DIR, `${key}.json`)
  // A finished week never changes, so it is fetched once. The current week is
  // always refetched, because it is still filling up.
  if (existsSync(path) && !unsettled.has(key)) continue
  const rows = (await fetchWeek(weekWindow(key), token)).map(toCached)
  // Write only on success: a partial file would be cached as if it were whole.
  // Write-then-rename so a process killed mid-write can't leave a truncated
  // file that the next run mistakes for a complete cached week.
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(rows))
  renameSync(tmp, path)
  console.log(`${key}: ${rows.length} merged pull requests`)
}

const weeks = new Map<string, CachedPr[]>()
for (const key of wanted) {
  const path = join(WEEKS_DIR, `${key}.json`)
  if (!existsSync(path)) continue
  weeks.set(key, JSON.parse(readFileSync(path, 'utf8')))
}

const holidays = new Set<string>(JSON.parse(readFileSync('holidays.json', 'utf8')))
const history = buildHistory(weeks, holidays, { bots: BOTS, generatedAt: new Date().toISOString() })

writeFileSync('data/history.json', JSON.stringify(history, null, 1))
console.log(`history: ${history.weeks.length} weeks, ${history.contributors.length} contributors`)
console.log(`machine-state files: ${history.machineStateFiles.length}`)
