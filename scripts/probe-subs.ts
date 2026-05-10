import { buildRedditRssUrl, parseRedditAtom } from '../src/agent/tools/reddit/list.js'
import { fetchRedditRss, DEFAULT_USER_AGENT } from '../src/agent/tools/reddit/shared.js'

const subs = [
  'artificial',
  'MachineLearning',
  'LocalLLaMA',
  'singularity',
  'ChatGPT',
  'ClaudeAI',
  'OpenAI',
  'StableDiffusion',
  'deeplearning',
  'agi',
  'ArtificialInteligence',
  'mlscaling',
  'reinforcementlearning',
  'comfyui',
  'Oobabooga',
]

async function main() {
  for (const sub of subs) {
    const url = buildRedditRssUrl(sub, 'hot')
    const r = await fetchRedditRss(url, { fetcher: fetch, userAgent: DEFAULT_USER_AGENT, timeoutMs: 8000 })
    if (r.status >= 200 && r.status < 300) {
      const entries = parseRedditAtom(r.body)
      const top = entries[0]?.title?.slice(0, 55) ?? '(empty)'
      console.log(`✅ r/${sub.padEnd(25)} ${String(entries.length).padStart(2)} posts | ${top}`)
    } else {
      console.log(`❌ r/${sub.padEnd(25)} HTTP ${r.status} ${r.errorKind ?? ''}`)
    }
  }
}

main()
