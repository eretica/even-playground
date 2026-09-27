// Jev API のニセ物(キー無しで配線を試す用)。POST /v1/systemone を受け、質問の型に応じたそれらしい答えを返す。
//   node scripts/fake-jev.mjs   →   TYPESAFE_API_KEY=fake TYPESAFE_BASE_URL=http://127.0.0.1:8799 npm run compare -- --providers jev,mock
import { createServer } from 'node:http'
const HALL = /ご視聴|チャンネル登録|^♪+$/
createServer((req, res) => {
  let body = ''
  req.on('data', c => body += c)
  req.on('end', () => {
    if (req.method !== 'POST' || req.url !== '/v1/systemone') { res.writeHead(404); return res.end('{}') }
    if (!/^Bearer /.test(req.headers.authorization || '')) { res.writeHead(401); return res.end('{"error":"no key"}') }
    const { state, questions, model } = JSON.parse(body)
    const text = JSON.stringify(state)
    const neg = (text.match(/疲れ|渋滞|ひど|もういい/g) || []).length
    const pos = (text.match(/楽し|落ち着|待ち遠し|キャンプ/g) || []).length
    const answers = {}
    for (const [k, q] of Object.entries(questions)) {
      if (q.type === 'noul') answers[k] = { type: 'noul', noul: HALL.test(text) ? 0.05 : 0.93 }
      else if (q.type === 'score') {
        const n = q.criteria.length
        const v = k === 'anger' ? Math.min(n - 1, neg * 0.6) : k === 'sorrow' ? Math.min(n - 1, neg * 0.8) : Math.min(n - 1, 1 + pos * 0.7 - neg * 0.3)
        const probs = {}; for (let i = 0; i < n; i++) probs[i] = Math.round(Math.max(0, 1 - Math.abs(i - v)) * 100) / 100
        answers[k] = { type: 'score', score: Math.max(0, v), confidence: 0.8, legend: Object.fromEntries(q.criteria.map((c, i) => [i, c])), probabilities: probs }
      } else {
        const labels = Object.keys(q.criteria)
        const pick = k === 'face' ? (neg > pos ? 'tired' : pos ? 'relaxed' : 'neutral') : (neg > pos ? 'お疲れ' : pos ? '落ち着き' : '様子見')
        const probs = Object.fromEntries(labels.map(l => [l, l === pick ? 0.7 : Math.round(0.3 / (labels.length - 1) * 100) / 100]))
        answers[k] = { type: 'choice', choice: labels.includes(pick) ? pick : labels[0], confidence: 0.7, probabilities: probs }
      }
    }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-typesafe-request-id': 'fake-1' })
      res.end(JSON.stringify({ model, answers, usage: { input_tokens: Math.ceil(body.length / 3), output_tokens: 0 } }))
    }, 120)
  })
}).listen(8799, () => console.log('fake jev on :8799'))
