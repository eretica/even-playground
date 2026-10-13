// 判定の評価: eval/*.txt の会話を流し、`=` 行(チェックポイント)で face / mood を正解と比べる。
//   npm run eval                        # Jev
//   npm run eval -- --providers jev,claude-code   # 他プロバイダも(mood はラベル体系が違うので face だけ比べる)
//   npm run eval -- --file eval/01-camp.txt -v
// 出すもの: face 一致率、mood 一致率、confidence 帯ごとの正解率(較正の確認)、外した箇所、Jev のモデル名。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { claudeCodeAvailable, claudeCodeProvider } from '../server/claude-code'
import { configFromEnv } from '../server/config'
import { MOODS, type JevLlmProvider } from '../server/jev'
import { availableLlms, type ExtraLlms } from '../server/llm'
import type { Analysis, AnalyzeRequest, Speaker, TranscriptTurn } from '../shared/types'

const argv = process.argv.slice(2)
const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const verbose = argv.includes('-v') || argv.includes('--verbose')

interface Checkpoint { afterTurn: number; faces: string[]; moods: string[] }
interface Case { name: string; turns: TranscriptTurn[]; checks: Checkpoint[] }

function parseCase(file: string): Case {
  const turns: TranscriptTurn[] = []
  const checks: Checkpoint[] = []
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const l = raw.trim()
    if (!l || l.startsWith('#')) continue
    if (l.startsWith('=')) {
      const faces = l.match(/face:(\S+)/)?.[1].split('|') ?? []
      const moods = l.match(/mood:(\S+)/)?.[1].split('|') ?? []
      if (!faces.length) throw new Error(`${file}: "=" 行に face: が必要: ${l}`)
      for (const m of moods) if (!(m in MOODS)) throw new Error(`${file}: 未知の mood "${m}"(MOODS: ${Object.keys(MOODS).join(' ')})`)
      checks.push({ afterTurn: turns.length, faces, moods })
      continue
    }
    const m = l.match(/^(self|other|unknown)\s*[:：]\s*(.+)$/)
    if (!m) throw new Error(`${file}: 形式不明の行: ${l}`)
    turns.push({ id: turns.length + 1, speaker: m[1] as Speaker, text: m[2], ts: turns.length * 4000 })
  }
  return { name: basename(file, '.txt'), turns, checks }
}

async function main() {
  const cfg = configFromEnv(process.env, { anthropicHasCreds: existsSync(join(homedir(), '.config', 'anthropic')) })
  const extra: ExtraLlms = claudeCodeAvailable(cfg.claudeBin) ? { full: { 'claude-code': claudeCodeProvider(cfg, () => undefined, 'full') } } : {}
  const all = availableLlms(cfg, extra)
  const names = (opt('--providers') ?? 'jev').split(',').map(s => s.trim()).filter(Boolean)
  for (const n of names) if (!all[n]) { console.error(`unknown provider ${n}. 使えるもの: ${Object.keys(all).join(', ')}`); process.exit(1) }
  const files = opt('--file') ? [opt('--file')!] : readdirSync('eval').filter(f => f.endsWith('.txt')).sort().map(f => join('eval', f))
  const cases = files.map(parseCase)
  console.log(`cases: ${cases.length}  checkpoints: ${cases.reduce((n, c) => n + c.checks.length, 0)}  providers: ${names.join(', ')}`)

  for (const name of names) {
    const p = all[name] as JevLlmProvider
    let faceOk = 0, faceN = 0, moodOk = 0, moodN = 0, ms: number[] = [], model = ''
    const buckets: Record<string, { ok: number; n: number }> = { '<0.5': { ok: 0, n: 0 }, '0.5-0.7': { ok: 0, n: 0 }, '0.7-0.9': { ok: 0, n: 0 }, '>=0.9': { ok: 0, n: 0 } }
    const bucket = (c: number) => (c < 0.5 ? '<0.5' : c < 0.7 ? '0.5-0.7' : c < 0.9 ? '0.7-0.9' : '>=0.9')
    const misses: string[] = []
    console.log(`\n== ${name}`)
    for (const c of cases) {
      let prev: Analysis | null = null
      const marks: string[] = []
      for (const ck of c.checks) {
        const req: AnalyzeRequest = { turns: c.turns.slice(0, ck.afterTurn), previous: prev, lang: 'ja', sessionKey: `eval-${name}-${c.name}-${process.pid}` }
        const t0 = Date.now()
        let a: Analysis
        try { a = await p.analyze(req) } catch (e) { marks.push(`✗(error ${(e as Error).message.slice(0, 60)})`); continue }
        ms.push(Date.now() - t0)
        prev = a
        const j = p.last
        if (j) model = j.model
        const fOk = ck.faces.includes(a.face)
        faceN++; if (fOk) faceOk++
        if (j) { const b = buckets[bucket(j.confidence.face)]; b.n++; if (fOk) b.ok++ }
        let mMark = ''
        if (ck.moods.length && name === 'jev') {
          const mOk = ck.moods.includes(a.mood)
          moodN++; if (mOk) moodOk++
          mMark = mOk ? '' : ` mood=${a.mood}≠${ck.moods.join('|')}`
          if (!mOk) misses.push(`${c.name}@${ck.afterTurn} mood ${a.mood} (期待 ${ck.moods.join('|')}, conf ${j?.confidence.mood ?? '-'})  "${c.turns[ck.afterTurn - 1].text}"`)
        }
        if (!fOk) misses.push(`${c.name}@${ck.afterTurn} face ${a.face} (期待 ${ck.faces.join('|')}, conf ${j?.confidence.face ?? '-'})  "${c.turns[ck.afterTurn - 1].text}"`)
        marks.push(`${fOk ? '✓' : '✗'}${a.face}${mMark}${j?.held.length ? `(held)` : ''}`)
        if (verbose && j) console.log(`  ${c.name}@${ck.afterTurn} ${a.face}/${a.mood} score=${a.score} conf face=${j.confidence.face} mood=${j.confidence.mood} ${Date.now() - t0}ms`)
      }
      console.log(`${c.name.padEnd(14)} ${marks.join('  ')}`)
    }
    const avg = ms.length ? Math.round(ms.reduce((x, y) => x + y, 0) / ms.length) : 0
    console.log(`\nface 一致 ${faceOk}/${faceN} (${faceN ? Math.round((faceOk / faceN) * 100) : 0}%)${moodN ? `  mood 一致 ${moodOk}/${moodN} (${Math.round((moodOk / moodN) * 100)}%)` : ''}  平均 ${avg}ms${model ? `  model ${model}` : ''}`)
    if (name === 'jev') console.log(`confidence 帯別の face 正解率: ${Object.entries(buckets).filter(([, b]) => b.n).map(([k, b]) => `${k}: ${b.ok}/${b.n}`).join('  ')}`)
    if (misses.length) { console.log('外した箇所:'); for (const m of misses) console.log(`  ${m}`) }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
