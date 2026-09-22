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
