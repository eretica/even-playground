// claude -p をアプリと同じ引数で直接叩き、生の結果 JSON を確認するデバッグ用スクリプト。
//   node --import tsx scripts/claude-p-debug.ts [turns数]
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { buildUserPrompt, SYSTEM_PROMPT } from '../server/prompt'
import { ANALYSIS_JSON_SCHEMA } from '../server/schema'
import type { AnalyzeRequest } from '../shared/types'

const n = Number(process.argv[2] || 6)
const lines = [
  ['self', '最近どうですか？'],
  ['other', '最近仕事が忙しくて疲れました。'],
  ['other', 'でも週末に友達とキャンプに行ったんです。'],
  ['other', '焚き火を見てるとなんか落ち着きますよね。'],
  ['self', 'いいですね。どこに行ったんですか？'],
  ['other', 'ただ帰りの渋滞が本当にひどくて、疲れました。'],
  ['other', '次はもう少し近場でいいかなって思ってます。'],
  ['other', 'あ、そういえば新しいカメラを買ったんですよ。'],
  ['other', '写真を撮るのが楽しくて、休みが待ち遠しいです。'],
]
const req: AnalyzeRequest = {
  turns: lines.slice(0, n).map(([speaker, text], i) => ({ id: i + 1, speaker: speaker as 'self' | 'other', text, ts: i })),
  previous: n > 3 ? {
    emotions: { joy: 40, anger: 15, sorrow: 35, pleasure: 45 }, face: 'relaxed', mood: '疲労と癒し', score: 55,
    scores: { engagement: 55, rapport: 40, openness: 45 }, digDeeper: [], suggestions: [], summary: '',
  } : null,
  lang: 'ja',
}
const args = [
  '-p', '--output-format', 'json', '--json-schema', JSON.stringify(ANALYSIS_JSON_SCHEMA),
  '--system-prompt', SYSTEM_PROMPT, '--model', process.env.CLAUDE_CODE_MODEL || 'sonnet',
  '--effort', process.env.CLAUDE_CODE_EFFORT || 'low', '--tools', '', '--max-turns', process.env.MAX_TURNS || '1',
  '--no-session-persistence', buildUserPrompt(req),
]
const t0 = Date.now()
const r = spawnSync('claude', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 })
writeFileSync('/tmp/claude-p-debug.json', r.stdout)
console.log('exit', r.status, 'ms', Date.now() - t0, 'stderr:', r.stderr.slice(0, 300))
try {
  const j = JSON.parse(r.stdout)
  console.log({ subtype: j.subtype, is_error: j.is_error, num_turns: j.num_turns, stop_reason: j.stop_reason, terminal_reason: j.terminal_reason, has_structured: j.structured_output !== undefined })
  console.log('result:', String(j.result).slice(0, 500))
} catch { console.log('stdout(head):', r.stdout.slice(0, 500)) }
