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
