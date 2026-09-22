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
