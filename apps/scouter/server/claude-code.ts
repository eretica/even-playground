// Claude Code(`claude -p`)を LLM プロバイダとして使う。Node 専用(子プロセスを起動する)。
// API キー不要。ログイン済みの Claude Code(サブスク)の枠で動く。
//   claude -p --output-format json --json-schema <schema> --system-prompt <prompt> --tools "" --max-turns 1 ...
// 結果 JSON の `structured_output` にスキーマ準拠の値が入る。
import { spawn, spawnSync } from 'node:child_process'
import type { Analysis, AnalyzeRequest } from '../shared/types'
import type { Config } from './config'
import type { LlmProvider } from './llm'
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt'
import { ANALYSIS_JSON_SCHEMA, AnalysisSchema, normalizeAnalysis } from './schema'

const TIMEOUT_MS = 90_000

export function claudeCodeAvailable(bin = 'claude'): string | null {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  if (r.status !== 0) return null
  return r.stdout.trim()
}

interface ClaudeResult {
  is_error?: boolean
  subtype?: string
  terminal_reason?: string
  num_turns?: number
  result?: string
  structured_output?: unknown
  duration_ms?: number
  total_cost_usd?: number
}

function tryJson(text: string | undefined): unknown {
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

export function claudeCodeProvider(cfg: Config): LlmProvider {
  return {
    name: 'claude-code',
    async analyze(req: AnalyzeRequest): Promise<Analysis> {
      const args = [
        '-p',
        '--output-format', 'json',
        '--json-schema', JSON.stringify(ANALYSIS_JSON_SCHEMA),
        '--system-prompt', SYSTEM_PROMPT,
        '--model', cfg.claudeCodeModel,
        '--effort', cfg.claudeCodeEffort,
        '--tools', '',
        // 構造化出力はツール呼び出しとして実装されており、長い会話では前置きに 1 ターン使うことがある。
        // 1 だと terminal_reason=max_turns で空振りするので余裕を持たせる(ツールは全部無効なので暴走しない)
        '--max-turns', '4',
        '--no-session-persistence',
        buildUserPrompt(req),
      ]
      // stdin は必ず閉じる(開いたままだと claude が 3 秒待って警告し、失敗することがある)
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(cfg.claudeBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        let err = ''
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`claude -p timeout ${TIMEOUT_MS}ms`)) }, TIMEOUT_MS)
        child.stdout.on('data', d => { out += d })
        child.stderr.on('data', d => { err += d })
        child.on('error', e => { clearTimeout(timer); reject(new Error(`claude -p spawn failed: ${e.message}`)) })
        child.on('close', code => {
          clearTimeout(timer)
          // 非 0 でも stdout に結果 JSON が出ていれば、そこから理由を読む(max_turns 等)
          if (code === 0 || out.trim().startsWith('{')) resolve(out)
          else reject(new Error(`claude -p exit ${code}: ${(err || out).slice(0, 300)}`))
        })
      })
      let parsed: ClaudeResult
      try {
        parsed = JSON.parse(stdout) as ClaudeResult
      } catch {
        throw new Error(`claude -p returned non-JSON: ${stdout.slice(0, 200)}`)
      }
      const raw = parsed.structured_output ?? tryJson(parsed.result)
      if (!raw) {
        const why = parsed.terminal_reason ?? parsed.subtype ?? 'unknown'
        throw new Error(`claude -p: 構造化出力なし (${why}${parsed.is_error ? ', is_error' : ''}) ${String(parsed.result ?? '').slice(0, 200)}`)
      }
      return normalizeAnalysis(AnalysisSchema.parse(raw))
    },
  }
}
