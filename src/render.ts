import { readFileSync, writeFileSync } from 'node:fs'

const template = readFileSync('dashboard.template.html', 'utf8')
const history = readFileSync('data/history.json', 'utf8')

if (!template.includes('/*__DATA__*/')) {
  throw new Error('dashboard.template.html is missing the /*__DATA__*/ marker')
}

writeFileSync('index.html', template.replace('/*__DATA__*/', () => history))
console.log(`index.html written, ${history.length} bytes of data embedded`)
