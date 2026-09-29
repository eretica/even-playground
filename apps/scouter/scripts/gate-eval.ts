// STT ゲートの精度評価: 幻聴・雑音サンプル vs 実発話サンプルで、正規表現(従来)と Jev(noul)の 判定を比べる。
//   npm run gate-eval                # 内蔵データ
//   npm run gate-eval -- --file samples.txt   # 1 行 `drop: テキスト` / `keep: テキスト`
// 出す数字: 幻聴の除去率(recall of drop)、実発話の誤除去率(false drop)、閾値を振った時の変化、外したサンプル一覧。
import { readFileSync } from 'node:fs'
import { configFromEnv } from '../server/config'
import { jevGate } from '../server/jev'
import { dropHallucination } from '../server/stt'

const argv = process.argv.slice(2)
const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }

// 実機・シミュレータで whisper が吐いた幻聴の型 + 実際の会話の断片(短い相槌・言いかけ・誤認識混じりも「残すべき」側)
const BUILTIN = `
drop: ご視聴ありがとうございました
drop: ご視聴ありがとうございました。
drop: チャンネル登録お願いします
drop: 字幕 by ○○
drop: おやすみなさい
drop: ありがとうございました
drop: ♪♪♪
drop: [音楽]
drop: (拍手)
drop: はいはいはいはいはいはいはい
drop: んんんんんん
drop: 。。。
drop: お疲れ様でした。ご視聴ありがとうございました
drop: 次の動画でお会いしましょう
drop: 提供
keep: うん
keep: へえ、そうなんですか
keep: えっと、なんだっけ、あのカメラの
keep: 最近仕事が忙しくて疲れました。
keep: それで結局、行けなくて。
keep: ありがとうございます、助かりました
keep: いや、そういうことじゃなくて
keep: ちょっと待って
keep: 焚き火を見てると落ち着きますよね
keep: 渋滞がひどくて、もうくたくたで
keep: おやすみ、また明日ね
keep: 網羅性っていうか、抜けがないかが気になって
keep: えー、それはちょっと
keep: スカウターのアプリ、グラスで動くやつ
keep: はいはい、なるほど
keep: 今日はありがとうございました
keep: うーん、どうだろう
keep: 写真撮るのが楽しくて休みが待ち遠しい
keep: 次はもう少し近場でいいかな
keep: え、それは…まあ普通のやつですよ
`

interface Sample { label: 'drop' | 'keep'; text: string }
function load(file?: string): Sample[] {
  const raw = file ? readFileSync(file, 'utf8') : BUILTIN
  return raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => {
    const m = l.match(/^(drop|keep)\s*[:：]\s*(.+)$/)
    if (!m) throw new Error(`bad line: ${l}`)
    return { label: m[1] as Sample['label'], text: m[2] }
  })
}

function report(name: string, rows: Array<{ s: Sample; dropped: boolean }>) {
  const drops = rows.filter(r => r.s.label === 'drop'), keeps = rows.filter(r => r.s.label === 'keep')
  const caught = drops.filter(r => r.dropped).length, falseDrop = keeps.filter(r => r.dropped).length
  console.log(`${name.padEnd(14)} 幻聴の除去 ${caught}/${drops.length}  実発話の誤除去 ${falseDrop}/${keeps.length}`)
  for (const r of rows) if ((r.s.label === 'drop') !== r.dropped) console.log(`    ✗ ${r.s.label === 'drop' ? '残った幻聴' : '消えた実発話'}: "${r.s.text}"`)
}

async function main() {
  const samples = load(opt('--file'))
  console.log(`samples: drop ${samples.filter(s => s.label === 'drop').length} / keep ${samples.filter(s => s.label === 'keep').length}\n`)
  report('regex(従来)', samples.map(s => ({ s, dropped: dropHallucination(s.text) === '' })))

  const cfg = configFromEnv(process.env)
  if (!cfg.typesafeKey) { console.log('\nTYPESAFE_API_KEY が無いので Jev 側はスキップ'); return }
  const gate = jevGate(cfg)
  const probs: Array<{ s: Sample; p: number; ms: number }> = []
  for (const s of samples) {
    try { const g = await gate.check(s.text, 'other'); probs.push({ s, p: g.p, ms: g.ms }) } catch (e) { console.log(`  jev error "${s.text}": ${(e as Error).message.slice(0, 100)}`) }
  }
  console.log()
  report(`jev(閾値 ${cfg.jevGateThreshold})`, probs.map(({ s, p }) => ({ s, dropped: p < cfg.jevGateThreshold })))
  const avg = Math.round(probs.reduce((a, r) => a + r.ms, 0) / Math.max(1, probs.length))
  console.log(`  平均 ${avg}ms/件`)
  console.log('\n閾値を振った場合(除去/幻聴数, 誤除去/実発話数):')
  for (const th of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
    const d = probs.filter(r => r.s.label === 'drop'), k = probs.filter(r => r.s.label === 'keep')
    console.log(`  ${th.toFixed(1)}: ${d.filter(r => r.p < th).length}/${d.length}, ${k.filter(r => r.p < th).length}/${k.length}`)
  }
  console.log('\n確率の低い順(境界の様子):')
  for (const r of [...probs].sort((a, b) => a.p - b.p).slice(0, 12)) console.log(`  ${r.p.toFixed(2)} ${r.s.label} "${r.s.text}"`)
}
main().catch(e => { console.error(e); process.exit(1) })
