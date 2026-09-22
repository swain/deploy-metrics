import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHistory } from '../src/aggregate.ts'
import { toCached } from '../src/classify.ts'
import type { RawPr } from '../src/classify.ts'

const pr = (over: Partial<RawPr> = {}): RawPr => ({
  repo: 'omni',
  number: 1,
  title: 'feat: x',
  login: 'alice',
  mergedAt: '2026-01-06T10:00:00Z',
  baseRefName: 'main',
  headRefName: 'feat/x',
  additions: 60,
  deletions: 40,
  changedFiles: 1,
  files: [{ path: 'src/a.ts', additions: 60, deletions: 40, changeType: 'MODIFIED' }],
  ...over,
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
  const weeks = new Map([
    [
      '2026-W02',
      [toCached(pr()), toCached(pr({ number: 2, baseRefName: 'master', headRefName: 'qa' }))],
    ],
  ])
  const h = buildHistory(weeks, new Set(), opts)
  assert.equal(h.weeks[0].totals.prs, 1)
  assert.equal(h.weeks[0].totals.lines, 100)
})

test('excluded repos contribute nothing, other repos in the same week are unaffected', () => {
  const weeks = new Map([
    ['2026-W02', [toCached(pr()), toCached(pr({ number: 2, repo: 'product-os', login: 'bob' }))]],
  ])
  const h = buildHistory(weeks, new Set(), opts)
  assert.equal(h.weeks[0].totals.prs, 1)
  assert.equal(h.weeks[0].totals.lines, 100)
  assert.deepEqual(
    h.weeks[0].contributors.map((c) => c.login),
    ['alice'],
  )
  assert(!h.contributors.includes('bob'))
})

test('excluded repos never reach machine-state detection', () => {
  const productOsPrs = Array.from({ length: 10 }, (_, i) =>
    toCached(
      pr({
        repo: 'product-os',
        number: 400 + i,
        login: 'ci',
        mergedAt: '2026-01-06T10:00:00Z',
        changedFiles: 1,
        additions: 2,
        deletions: 0,
        files: [{ path: 'noisy.json', additions: 2, deletions: 0, changeType: 'MODIFIED' }],
      }),
    ),
  )
  const weeks = new Map([['2026-W02', productOsPrs]])
  const h = buildHistory(weeks, new Set(), opts)
  assert(!h.machineStateFiles.includes('product-os/noisy.json'))
})

test('bots are held out of totals and reported separately', () => {
  const weeks = new Map([
    ['2026-W02', [toCached(pr()), toCached(pr({ number: 2, login: 'robot' }))]],
  ])
  const h = buildHistory(weeks, new Set(), opts)
  assert.equal(h.weeks[0].totals.prs, 1)
  assert.deepEqual(
    h.weeks[0].contributors.map((c) => c.login),
    ['alice'],
  )
  assert.equal(h.bots.robot.prs, 1)
  assert(!h.contributors.includes('robot'))
})

test('weeks come out in chronological order and carry the contributor index', () => {
  const weeks = new Map([
    ['2026-W03', [toCached(pr({ mergedAt: '2026-01-13T10:00:00Z', login: 'bob' }))]],
    ['2026-W02', [toCached(pr())]],
  ])
  const h = buildHistory(weeks, new Set(), opts)
  assert.deepEqual(
    h.weeks.map((w) => w.week),
    ['2026-W02', '2026-W03'],
  )
  assert.deepEqual([...h.contributors].sort(), ['alice', 'bob'])
  assert.equal(h.generatedAt, '2026-09-22T00:00:00Z')
})

test('machine-state detection works globally across weeks', () => {
  const w02Prs = Array.from({ length: 6 }, (_, i) =>
    toCached(
      pr({
        number: 100 + i,
        login: 'ci',
        mergedAt: '2026-01-06T10:00:00Z',
        changedFiles: 1,
        additions: 2,
        deletions: 0,
        files: [{ path: 'lock.json', additions: 2, deletions: 0, changeType: 'MODIFIED' }],
      }),
    ),
  )
  const w03Prs = Array.from({ length: 6 }, (_, i) =>
    toCached(
      pr({
        number: 200 + i,
        login: 'ci',
        mergedAt: '2026-01-13T10:00:00Z',
        changedFiles: 1,
        additions: 2,
        deletions: 0,
        files: [{ path: 'lock.json', additions: 2, deletions: 0, changeType: 'MODIFIED' }],
      }),
    ),
  )
  const weeks = new Map([
    ['2026-W02', w02Prs],
    ['2026-W03', w03Prs],
  ])
  const h = buildHistory(weeks, new Set(), opts)
  assert.equal(h.weeks[0].totals.prs, 0, '2026-W02 should have 0 qualifying PRs')
  assert.equal(h.weeks[1].totals.prs, 0, '2026-W03 should have 0 qualifying PRs')
  assert(
    h.machineStateFiles.includes('omni/lock.json'),
    'detected file should be in machineStateFiles',
  )
})

test('the week containing generatedAt is partial and counts only elapsed working days', () => {
  const weeks = new Map([
    ['2026-W02', [toCached(pr())]],
    ['2026-W03', [toCached(pr({ mergedAt: '2026-01-13T10:00:00Z', login: 'bob' }))]],
  ])
  const wednesdayOpts = { bots: new Set(['robot']), generatedAt: '2026-01-14T12:00:00Z' }
  const h = buildHistory(weeks, new Set(), wednesdayOpts)
  const w02 = h.weeks.find((w) => w.week === '2026-W02')!
  const w03 = h.weeks.find((w) => w.week === '2026-W03')!
  assert.equal(w02.workingDays, 5)
  assert.equal(w02.partial, false)
  assert.equal(w03.workingDays, 3)
  assert.equal(w03.partial, true)
})

test('a week whose only elapsed working day is a holiday is omitted, not floored to 1', () => {
  const weeks = new Map([
    ['2026-W02', [toCached(pr())]],
    ['2026-W03', [toCached(pr({ mergedAt: '2026-01-12T10:00:00Z', login: 'bob' }))]],
  ])
  const holidayMondayOpts = { bots: new Set(['robot']), generatedAt: '2026-01-12T12:00:00Z' }
  const h = buildHistory(weeks, new Set(['2026-01-12']), holidayMondayOpts)
  assert.deepEqual(
    h.weeks.map((w) => w.week),
    ['2026-W02'],
  )
  assert.equal(h.weeks[0].workingDays, 5)
  assert.equal(h.weeks[0].totals.lines, 100)
})

test('a settled week where every weekday is a holiday is omitted, not emitted with workingDays: 0', () => {
  const weeks = new Map([
    ['2026-W02', [toCached(pr())]],
    ['2026-W03', [toCached(pr({ mergedAt: '2026-01-13T10:00:00Z', login: 'bob' }))]],
  ])
  const shutdownHolidays = new Set([
    '2026-01-05',
    '2026-01-06',
    '2026-01-07',
    '2026-01-08',
    '2026-01-09',
  ])
  const laterGeneratedAtOpts = { bots: new Set(['robot']), generatedAt: '2026-01-14T12:00:00Z' }
  const h = buildHistory(weeks, shutdownHolidays, laterGeneratedAtOpts)
  assert.deepEqual(
    h.weeks.map((w) => w.week),
    ['2026-W03'],
  )
})

test('a file under the machine-state threshold counts normally', () => {
  const nineOnly = Array.from({ length: 9 }, (_, i) =>
    toCached(
      pr({
        number: 300 + i,
        login: 'ci',
        mergedAt: '2026-01-06T10:00:00Z',
        changedFiles: 1,
        additions: 2,
        deletions: 0,
        files: [{ path: 'other.json', additions: 2, deletions: 0, changeType: 'MODIFIED' }],
      }),
    ),
  )
  const weeks = new Map([['2026-W02', nineOnly]])
  const h = buildHistory(weeks, new Set(), opts)
  assert.equal(h.weeks[0].totals.prs, 9, '9 PRs should not be excluded')
  assert.equal(h.weeks[0].contributors[0].prs, 9)
  assert(
    !h.machineStateFiles.includes('omni/other.json'),
    'file under threshold should not be detected',
  )
})
