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
