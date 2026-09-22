import type { RawPr, RawFile } from './classify.ts'

const ENDPOINT = 'https://api.github.com/graphql'
const ORG = 'thegoodparty'

const SEARCH = `
query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 20, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title mergedAt baseRefName headRefName additions deletions changedFiles
      author { login }
      repository { name }
      files(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes { path additions deletions changeType }
      }
    } }
  }
}`

const FILES = `
query($repo: String!, $number: Int!, $after: String) {
  repository(owner: "${ORG}", name: $repo) {
    pullRequest(number: $number) {
      files(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { path additions deletions changeType }
      }
    }
  }
}`

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const gql = async (query: string, variables: Record<string, unknown>, token: string): Promise<any> => {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      })
      if (!res.ok) {
        if ([429, 500, 502, 503].includes(res.status)) { await sleep(5000 * (attempt + 1)); continue }
        throw new Error(`GitHub HTTP ${res.status}`)
      }
      const body = await res.json()
      if (body.errors && !body.data) {
        const message = JSON.stringify(body.errors).slice(0, 200)
        if (message.includes('RATE_LIMITED')) { await sleep(30_000); continue }
        throw new Error(`GitHub GraphQL: ${message}`)
      }
      return body.data
    } catch (error) {
      if (attempt === 5) throw error
      await sleep(5000 * (attempt + 1))
    }
  }
  throw new Error('unreachable')
}

const pageFiles = async (repo: string, number: number, after: string, token: string): Promise<RawFile[]> => {
  const out: RawFile[] = []
  let cursor: string | null = after
  for (let guard = 0; guard < 60 && cursor; guard++) {
    const data = await gql(FILES, { repo, number, after: cursor }, token)
    const files = data.repository.pullRequest.files
    out.push(...files.nodes)
    cursor = files.pageInfo.hasNextPage ? files.pageInfo.endCursor : null
  }
  return out
}

export const fetchWeek = async (
  window: { from: string; to: string },
  token: string,
): Promise<RawPr[]> => {
  const q = `org:${ORG} is:pr is:merged merged:${window.from}..${window.to} sort:created-asc`
  const out: RawPr[] = []
  let after: string | null = null

  for (;;) {
    const data = await gql(SEARCH, { q, after }, token)
    const search = data.search
    if (search.issueCount >= 1000) {
      throw new Error(`week ${window.from} hit the 1000-result search cap; narrow the window`)
    }
    for (const node of search.nodes) {
      if (!node || !node.mergedAt) continue
      const files: RawFile[] = [...node.files.nodes]
      if (node.files.pageInfo.hasNextPage) {
        files.push(...await pageFiles(node.repository.name, node.number, node.files.pageInfo.endCursor, token))
      }
      out.push({
        repo: node.repository.name,
        number: node.number,
        title: node.title,
        login: node.author?.login ?? '(ghost)',
        mergedAt: node.mergedAt,
        baseRefName: node.baseRefName,
        headRefName: node.headRefName,
        additions: node.additions,
        deletions: node.deletions,
        changedFiles: node.changedFiles,
        files,
      })
    }
    if (!search.pageInfo.hasNextPage) break
    after = search.pageInfo.endCursor
  }
  return out
}
