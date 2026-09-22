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
