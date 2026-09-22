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
