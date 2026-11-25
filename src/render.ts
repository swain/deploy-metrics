import { readFileSync, writeFileSync } from 'node:fs'
import type { History } from './aggregate.ts'

const template = readFileSync('dashboard.template.html', 'utf8')
const history = readFileSync('data/history.json', 'utf8')

if (!template.includes('/*__DATA__*/')) {
  throw new Error('dashboard.template.html is missing the /*__DATA__*/ marker')
}

const { weeks }: History = JSON.parse(history)
if (weeks.some(({ totals }) => !Number.isSafeInteger(totals.addedLines) || !Number.isSafeInteger(totals.removedLines))) {
  throw new Error('Dashboard data lacks separate line counts. Run npm run build to refresh it.')
}
if (weeks.some((week) => !week.bots)) {
  throw new Error('Dashboard data lacks weekly bot counts. Run npm run build to refresh it.')
}

writeFileSync('index.html', template.replace('/*__DATA__*/', () => history))
console.log(`index.html written, ${history.length} bytes of data embedded`)
