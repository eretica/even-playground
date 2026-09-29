// Jev の性能テスト: レイテンシ分布(p50 / p95 / max)、入力トークン数、コスト試算、並列時の挙動、ゲートの速さ。
//   npm run bench                         # 判定 20 回(直列) + 並列 5 + ゲート 10 回
//   npm run bench -- --n 50 --parallel 8 --turns 3,6,10
// env は server/.env(TYPESAFE_API_KEY)。キー無しの配線確認は `node scripts/fake-jev.mjs` + TYPESAFE_BASE_URL。
import { configFromEnv } from '../server/config'
import { buildJevState, jevGate, jevJudge } from '../server/jev'
import type { AnalyzeRequest, Speaker, TranscriptTurn } from '../shared/types'

const argv = process.argv.slice(2)
const opt = (name: string, d: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d }
const N = Number(opt('--n', '20'))
const PARALLEL = Number(opt('--parallel', '5'))
const TURNS = opt('--turns', '3,6,10').split(',').map(Number)
const PRICE_PER_MTOK = 0.042

const LINES: Array<[Speaker, string]> = [
  ['self', '最近どうですか？'], ['other', '最近仕事が忙しくて疲れました。'], ['other', 'でも週末に友達とキャンプに行ったんです。'],
  ['other', '焚き火を見てるとなんか落ち着きますよね。'], ['self', 'いいですね。どこに行ったんですか？'], ['other', 'ただ帰りの渋滞が本当にひどくて、疲れました。'],
  ['other', '次はもう少し近場でいいかなって思ってます。'], ['other', 'あ、そういえば新しいカメラを買ったんですよ。'], ['other', '写真を撮るのが楽しくて、休みが待ち遠しいです。'],
  ['self', 'へえ、どんなカメラですか？'], ['other', 'え、それは…まあ、普通のやつですよ。'], ['other', 'ていうか、その話はもういいじゃないですか。'],
]
const turns: TranscriptTurn[] = LINES.map(([speaker, text], i) => ({ id: i + 1, speaker, text, ts: i * 4000 }))
const req: AnalyzeRequest = {
  turns, lang: 'ja',
  previous: { emotions: { joy: 40, anger: 15, sorrow: 35, pleasure: 45 }, face: 'relaxed', mood: '落ち着き', score: 55, scores: { engagement: 55, rapport: 40, openness: 45 }, digDeeper: [], suggestions: [], summary: '', memory: 'キャンプ帰りの渋滞で疲れた。新しいカメラを買って写真に夢中' },
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] ?? 0 }
const dist = (xs: number[]) => `p50 ${pct(xs, 0.5)}ms  p95 ${pct(xs, 0.95)}ms  max ${Math.max(...xs)}ms  min ${Math.min(...xs)}ms`

async function main() {
  const cfg = configFromEnv(process.env)
  if (!cfg.typesafeKey) { console.error('TYPESAFE_API_KEY が未設定(server/.env)。配線確認だけなら node scripts/fake-jev.mjs を立てて TYPESAFE_BASE_URL=http://127.0.0.1:8799 TYPESAFE_API_KEY=fake'); process.exit(1) }
  console.log(`model ${cfg.jevModel}  base ${cfg.typesafeBaseUrl ?? '(default)'}  n=${N} parallel=${PARALLEL}`)

  // 1. 直列: JEV_TURNS ごとのレイテンシとトークン
  for (const t of TURNS) {
    const c = { ...cfg, jevTurns: t }
    const ms: number[] = []; let tokens = 0; let errors = 0; let faces: Record<string, number> = {}
    const stateChars = JSON.stringify(buildJevState(req, t)).length
    for (let i = 0; i < N; i++) {
      try { const j = await jevJudge(c, req); ms.push(j.ms); tokens += j.usage.input_tokens; faces[j.face] = (faces[j.face] ?? 0) + 1 } catch (e) { errors++; if (errors === 1) console.log(`  error: ${(e as Error).message.slice(0, 160)}`) }
    }
    if (!ms.length) continue
    const avgTok = Math.round(tokens / ms.length)
    console.log(`turns=${t}  state ${stateChars} 文字  in ${avgTok} tok/回  ${dist(ms)}  errors ${errors}  face 分布 ${JSON.stringify(faces)}`)
    console.log(`  コスト: 1 回 $${(avgTok / 1e6 * PRICE_PER_MTOK).toFixed(6)} → 1 時間の会話(15 秒おき 240 回) $${(avgTok * 240 / 1e6 * PRICE_PER_MTOK).toFixed(4)}`)
  }

  // 2. 並列: 同時に投げた時の 1 件あたりと全体
  if (PARALLEL > 1) {
    const t0 = Date.now()
    const rs = await Promise.allSettled(Array.from({ length: PARALLEL }, () => jevJudge(cfg, req)))
    const ok = rs.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof jevJudge>>>).value.ms)
    const failed = rs.filter(r => r.status === 'rejected')
    console.log(`parallel ${PARALLEL}: 全体 ${Date.now() - t0}ms  1 件 ${ok.length ? dist(ok) : '-'}  failed ${failed.length}${failed.length ? ` (${((failed[0] as PromiseRejectedResult).reason as Error).message.slice(0, 100)})` : ''}`)
  }

  // 3. ゲート(noul 1 問)
  const gate = jevGate(cfg)
  const gms: number[] = []
  const samples = ['そうなんですよ、それで結局行けなくて。', 'ご視聴ありがとうございました', 'うん', 'えっと、なんだっけ、あのカメラの', '♪♪♪']
  for (let i = 0; i < Math.min(N, 10); i++) {
    const s = samples[i % samples.length]
    try { const g = await gate.check(s, 'other'); gms.push(g.ms); if (i < samples.length) console.log(`  gate p=${g.p.toFixed(2)} ${g.keep ? 'keep' : 'DROP'} "${s}"`) } catch (e) { console.log(`  gate error: ${(e as Error).message.slice(0, 100)}`) }
  }
  if (gms.length) console.log(`gate: ${dist(gms)}`)
}
main().catch(e => { console.error(e); process.exit(1) })
