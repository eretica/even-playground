// 同じ会話を複数プロバイダ(従来 LLM / jev / jev+LLM)に流し、判定と所要時間を並べて比較する。
//   npm run compare                                   # 使えるプロバイダ全部(mock 除く)
//   npm run compare -- --providers jev,claude-code    # 指定
//   npm run compare -- --file talk.txt --step 1 -v    # 会話ファイル(下記形式)、毎発話で解析、Jev の確率分布も表示
//
// 会話ファイル: 1 行 1 発話 `other: テキスト` / `self: テキスト`(# 行は無視)。.json なら [{speaker,text}] の配列。
// アプリと同じく「発話が増えるたびに previous を渡して更新」する流れを再現する。
// env は server/.env を読む(TYPESAFE_API_KEY / LLM 側のキー)。claude-code は `claude` がログイン済みなら使える。
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeCodeAvailable, claudeCodeProvider } from '../server/claude-code'
import { configFromEnv } from '../server/config'
import type { JevLlmProvider } from '../server/jev'
import { availableLlms, type LlmProvider } from '../server/llm'
import type { Analysis, AnalyzeRequest, Speaker, TranscriptTurn } from '../shared/types'

const argv = process.argv.slice(2)
const opt = (name: string, d?: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d }
const flag = (...names: string[]) => names.some(n => argv.includes(n))

const DEFAULT_LINES = `
self: 最近どうですか？
other: 最近仕事が忙しくて疲れました。
other: でも週末に友達とキャンプに行ったんです。
other: 焚き火を見てるとなんか落ち着きますよね。
self: いいですね。どこに行ったんですか？
other: ただ帰りの渋滞が本当にひどくて、疲れました。
other: 次はもう少し近場でいいかなって思ってます。
other: あ、そういえば新しいカメラを買ったんですよ。
other: 写真を撮るのが楽しくて、休みが待ち遠しいです。
self: へえ、どんなカメラですか？
other: え、それは…まあ、普通のやつですよ。
other: ていうか、その話はもういいじゃないですか。
`

function loadTurns(file?: string): TranscriptTurn[] {
  let items: Array<{ speaker: Speaker; text: string }>
  if (file && file.endsWith('.json')) {
    items = JSON.parse(readFileSync(file, 'utf8'))
  } else {
    const raw = file ? readFileSync(file, 'utf8') : DEFAULT_LINES
    items = raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => {
      const m = l.match(/^(self|other|unknown)\s*[:：]\s*(.+)$/)
      return m ? { speaker: m[1] as Speaker, text: m[2] } : { speaker: 'other' as Speaker, text: l }
    })
  }
  return items.map((t, i) => ({ id: i + 1, speaker: t.speaker, text: t.text, ts: i * 4000 }))
}

// ---- 表示(全角を 2 桁で数える) ----
const width = (s: string) => [...s].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0)
const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - width(s)))
const cut = (s: string, w: number) => { let out = ''; for (const ch of [...s]) { if (width(out + ch) > w) break; out += ch } return out }
const cell = (s: string, w: number) => pad(cut(s, w), w)

function row(cols: Array<[string, number]>): string {
  return cols.map(([s, w]) => cell(s, w)).join(' ')
}
const COLS: Array<[string, number]> = [['provider', 18], ['ms', 6], ['face', 9], ['mood', 10], ['score', 5], ['喜/怒/哀/楽', 15], ['関/親/本', 11], ['suggestion / summary', 40]]

function fmt(name: string, ms: number, a: Analysis): string {
  const e = a.emotions, s = a.scores
  return row([
    [name, 18], [String(ms), 6], [a.face, 9], [a.mood, 10], [String(a.score), 5],
    [`${e.joy}/${e.anger}/${e.sorrow}/${e.pleasure}`, 15], [`${s.engagement}/${s.rapport}/${s.openness}`, 11],
    [a.suggestions[0] || a.summary, 40],
  ])
}

async function main() {
  const cfg = configFromEnv(process.env, { anthropicHasCreds: existsSync(join(homedir(), '.config', 'anthropic')) })
  const extra: Record<string, LlmProvider> = claudeCodeAvailable(cfg.claudeBin) ? { 'claude-code': claudeCodeProvider(cfg, () => undefined) } : {}
  const all = availableLlms(cfg, extra)
  const names = (opt('--providers') ?? Object.keys(all).filter(n => n !== 'mock' && n !== 'jev+mock').join(',')).split(',').map(s => s.trim()).filter(Boolean)
  const missing = names.filter(n => !all[n])
  if (missing.length) {
    console.error(`unknown provider: ${missing.join(', ')}\n使えるもの: ${Object.keys(all).join(', ')}${cfg.typesafeKey ? '' : '\n(TYPESAFE_API_KEY が無いので jev 系は出ません)'}`)
    process.exit(1)
  }
  const turns = loadTurns(opt('--file'))
  const step = Math.max(1, Number(opt('--step', '2')) || 2)
  const verbose = flag('-v', '--verbose')
  const lang = opt('--lang', 'ja')

  console.log(`providers: ${names.join(', ')}   turns: ${turns.length}   step: ${step}   jev model: ${cfg.jevModel} (turns=${cfg.jevTurns})`)
  const prev: Record<string, Analysis | null> = Object.fromEntries(names.map(n => [n, null]))
  const stats: Record<string, { ms: number[]; faces: string[]; scores: number[]; errors: number }> = Object.fromEntries(names.map(n => [n, { ms: [], faces: [], scores: [], errors: 0 }]))

  const points: number[] = []
  for (let i = step; i < turns.length; i += step) points.push(i)
  if (points.at(-1) !== turns.length) points.push(turns.length)

  for (const n of points) {
    const slice = turns.slice(0, n)
    const last = slice.at(-1)!
    console.log(`\n== ${n}/${turns.length} 発話目まで   最新: ${last.speaker}: ${last.text}`)
    console.log(row(COLS))
    for (const name of names) {
      const p = all[name] as JevLlmProvider
      const req: AnalyzeRequest = { turns: slice, previous: prev[name], lang, sessionKey: `compare-${name}-${process.pid}` }
      const t0 = Date.now()
      try {
        const a = await p.analyze(req)
        const ms = Date.now() - t0
        prev[name] = a
        stats[name].ms.push(ms); stats[name].faces.push(a.face); stats[name].scores.push(a.score)
        console.log(fmt(name, ms, a))
        if (verbose && p.last) {
          const j = p.last
          const top = (k: string) => Object.entries(j.probabilities[k] ?? {}).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([l, v]) => `${l}:${Math.round(v * 100)}%`).join(' ')
          console.log(`    jev ${j.ms}ms in=${j.usage.input_tokens}tok  face[${top('face')}]  mood[${top('mood')}]  enjoy[${top('enjoy')}]`)
        }
      } catch (e) {
        stats[name].errors++
        console.log(row([[name, 18], [String(Date.now() - t0), 6], [`ERROR ${(e as Error).message.slice(0, 100)}`, 100]]))
      }
    }
  }

  console.log('\n== まとめ')
  const base = names[0]
  for (const name of names) {
    const s = stats[name]
    const avg = s.ms.length ? Math.round(s.ms.reduce((a, b) => a + b, 0) / s.ms.length) : 0
    const med = s.ms.length ? [...s.ms].sort((a, b) => a - b)[Math.floor(s.ms.length / 2)] : 0
    let agree = ''
    if (name !== base) {
      const n = Math.min(s.faces.length, stats[base].faces.length)
      const same = s.faces.filter((f, i) => f === stats[base].faces[i]).length
      const diff = s.scores.map((v, i) => Math.abs(v - (stats[base].scores[i] ?? v))).slice(0, n)
      const mad = diff.length ? Math.round(diff.reduce((a, b) => a + b, 0) / diff.length) : 0
      agree = `  face 一致 ${same}/${n} (vs ${base})  score 平均差 ${mad}`
    }
    console.log(`${cell(name, 18)} avg ${avg}ms  median ${med}ms  errors ${s.errors}${agree}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
