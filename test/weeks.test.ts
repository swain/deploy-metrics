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
