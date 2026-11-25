import { detectMachineState, isQualifying } from './classify.ts'
import type { CachedPr } from './classify.ts'
import { isoWeekKey, weekStartUTC, workingDays } from './weeks.ts'

interface Counts {
  prs: number
  lines: number
  addedLines: number
  removedLines: number
}

export interface ContributorWeek extends Counts {
  login: string
  addedRaw: number
  deletedRaw: number
  repos: Record<string, Counts>
}

export interface WeekSummary {
  week: string
  weekStart: string
  workingDays: number
  partial: boolean
  totals: Counts & { addedRaw: number; deletedRaw: number; people: number }
  contributors: ContributorWeek[]
}

const DAY = 86_400_000

const EXCLUDED_REPOS = new Set(['product-os'])

// Mon-Fri/holiday count for the current week, stopping at generatedAt's calendar
// date (inclusive) since later weekdays haven't happened yet. weekStartUTC gives
// midnight-UTC day boundaries, so comparing raw timestamps against `now` is safe.
const workingDaysElapsed = (key: string, holidays: Set<string>, now: Date): number => {
  const start = weekStartUTC(key)
  let n = 0
  for (let i = 0; i < 5; i++) {
    const d = new Date(start.getTime() + i * DAY)
    if (d.getTime() > now.getTime()) break
    const dateKey = d.toISOString().slice(0, 10)
    if (!holidays.has(dateKey)) n++
  }
  return n
}

export interface History {
  generatedAt: string
  contributors: string[]
  weeks: WeekSummary[]
  bots: Record<string, Counts>
  machineStateFiles: string[]
}

const blankCounts = (): Counts => ({ prs: 0, lines: 0, addedLines: 0, removedLines: 0 })

const countPr = (counts: Counts, row: CachedPr) => {
  counts.prs += 1
  counts.lines += row.qlocBase
  counts.addedLines += row.addedLines
  counts.removedLines += row.removedLines
}

const blank = (login: string): ContributorWeek => ({
  login,
  ...blankCounts(),
  addedRaw: 0,
  deletedRaw: 0,
  repos: {},
})

export const buildHistory = (
  weeks: Map<string, CachedPr[]>,
  holidays: Set<string>,
  options: { bots: Set<string>; generatedAt: string },
): History => {
  const all = [...weeks.values()].flat().filter((r) => !EXCLUDED_REPOS.has(r.repo))
  const machine = detectMachineState(all)

  const now = new Date(options.generatedAt)
  const currentWeekKey = isoWeekKey(options.generatedAt)

  const bots: Record<string, Counts> = {}
  const people = new Set<string>()
  const summaries: WeekSummary[] = []

  for (const key of [...weeks.keys()].sort()) {
    const rows = (weeks.get(key) ?? [])
      .filter((r) => !EXCLUDED_REPOS.has(r.repo))
      .filter((r) => isQualifying(r, machine))
    const byLogin = new Map<string, ContributorWeek>()

    for (const row of rows) {
      if (options.bots.has(row.login)) {
        const bot = bots[row.login] ?? blankCounts()
        countPr(bot, row)
        bots[row.login] = bot
        continue
      }
      const entry = byLogin.get(row.login) ?? blank(row.login)
      countPr(entry, row)
      entry.addedRaw += row.added
      entry.deletedRaw += row.deleted
      const repoEntry = entry.repos[row.repo] ?? blankCounts()
      countPr(repoEntry, row)
      entry.repos[row.repo] = repoEntry
      byLogin.set(row.login, entry)
      people.add(row.login)
    }

    const contributors = [...byLogin.values()].sort((a, b) => b.lines - a.lines)
    const partial = key === currentWeekKey
    const elapsed = partial ? workingDaysElapsed(key, holidays, now) : workingDays(key, holidays)

    // A week with zero working days has no rate. For the in-progress week that
    // means no weekday has elapsed yet; for a settled week it means every
    // weekday was a holiday. Either way, plotting it would divide by a working
    // day that never happened, so the week is omitted rather than given an
    // invented denominator.
    if (elapsed === 0) continue

    summaries.push({
      week: key,
      // Derived once here, server-side, so the page never has to reimplement
      // ISO week arithmetic just to print a date.
      weekStart: weekStartUTC(key).toISOString().slice(0, 10),
      workingDays: elapsed,
      partial,
      totals: {
        prs: contributors.reduce((n, c) => n + c.prs, 0),
        lines: contributors.reduce((n, c) => n + c.lines, 0),
        addedLines: contributors.reduce((n, c) => n + c.addedLines, 0),
        removedLines: contributors.reduce((n, c) => n + c.removedLines, 0),
        addedRaw: contributors.reduce((n, c) => n + c.addedRaw, 0),
        deletedRaw: contributors.reduce((n, c) => n + c.deletedRaw, 0),
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
