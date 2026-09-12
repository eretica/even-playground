// claude -p をアプリと同じ引数で直接叩き、生の結果 JSON を確認するデバッグ用スクリプト。
//   node --import tsx scripts/claude-p-debug.ts [turns数]
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { buildUserPrompt, SYSTEM_PROMPT } from '../server/prompt'
import { ANALYSIS_JSON_SCHEMA } from '../server/schema'
import type { AnalyzeRequest } from '../shared/types'
import { claudeWorkDir } from '../server/claude-code'

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
const STREAM = process.env.STREAM === '1'
const args = [
  '-p', '--output-format', STREAM ? 'stream-json' : 'json', ...(STREAM ? ['--verbose'] : []), '--json-schema', JSON.stringify(ANALYSIS_JSON_SCHEMA),
  '--system-prompt', SYSTEM_PROMPT, '--model', process.env.CLAUDE_CODE_MODEL || 'sonnet',
  '--effort', process.env.CLAUDE_CODE_EFFORT || 'low', '--tools', '', '--max-turns', process.env.MAX_TURNS || '1',
  '--no-session-persistence', buildUserPrompt(req),
]
const t0 = Date.now()
const r = spawnSync('claude', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, cwd: process.env.KEEP_CWD ? undefined : claudeWorkDir() })
writeFileSync('/tmp/claude-p-debug.json', r.stdout)
console.log('exit', r.status, 'ms', Date.now() - t0, 'stderr:', r.stderr.slice(0, 300))
if (STREAM) {
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line)
      if (ev.type === 'assistant') {
        for (const b of ev.message?.content ?? []) {
          if (b.type === 'text') console.log('[assistant text]', String(b.text).slice(0, 300))
          else if (b.type === 'tool_use') console.log('[assistant tool_use]', b.name, JSON.stringify(b.input).slice(0, 120))
          else if (b.type === 'thinking') console.log('[assistant thinking]', String(b.thinking ?? '').slice(0, 120))
          else console.log('[assistant]', b.type)
        }
      } else if (ev.type === 'user') {
        for (const b of ev.message?.content ?? []) if (b.type === 'tool_result') console.log('[tool_result]', String(JSON.stringify(b.content)).slice(0, 160))
      } else if (ev.type === 'result') {
        console.log('[result]', { num_turns: ev.num_turns, terminal_reason: ev.terminal_reason, duration_ms: ev.duration_ms, api_ms: ev.duration_api_ms, usage: ev.usage && { in: ev.usage.input_tokens, cache_read: ev.usage.cache_read_input_tokens, cache_create: ev.usage.cache_creation_input_tokens, out: ev.usage.output_tokens, thinking: ev.usage.output_tokens_details?.thinking_tokens } })
      }
    } catch {}
  }
  process.exit(0)
}
try {
  const j = JSON.parse(r.stdout)
  console.log({ subtype: j.subtype, is_error: j.is_error, num_turns: j.num_turns, stop_reason: j.stop_reason, terminal_reason: j.terminal_reason, has_structured: j.structured_output !== undefined })
  console.log('result:', String(j.result).slice(0, 500))
} catch { console.log('stdout(head):', r.stdout.slice(0, 500)) }
