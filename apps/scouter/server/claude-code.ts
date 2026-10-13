// Claude Code(`claude -p`)を LLM プロバイダとして使う。Node 専用(子プロセスを起動する)。
// API キー不要。ログイン済みの Claude Code(サブスク)の枠で動く。
//
// 2 つのモード(CLAUDE_CODE_SESSION):
//   1 (既定) セッション継続: 初回は会話履歴を渡してセッションを作り、以降は `--resume <id>` で
//            新しい発話だけを渡す。入力が小さくキャッシュも効くので 1 回 ~3 秒。
//            上限(呼び出し回数 / 経過時間)に達したら、memory(要約)+ 直近 N 発話で新セッションに巻き直す。
//   0        毎回独立: memory + 直近 N 発話を渡す(セッションファイルを残さない)。
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Analysis, AnalyzeRequest, TranscriptTurn } from '../shared/types'
import type { Config } from './config'
import type { LlmProvider } from './llm'
import { deltaPromptFor, systemPromptFor, userPromptFor } from './prompt'
import { jsonSchemaFor, toAnalysis, type LlmMode } from './schema'

const TIMEOUT_MS = 90_000

/**
 * claude -p を起動する作業ディレクトリ。リポジトリ内で起動すると CLAUDE.md やメモリが自動で読み込まれ、
 * 入力が 1 万トークン超に膨らんで遅く・高くなるので、空のディレクトリで動かす。
 */
export function claudeWorkDir(): string {
  const dir = join(tmpdir(), 'scouter-claude-p')
  mkdirSync(dir, { recursive: true })
  return dir
}

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
  session_id?: string
  result?: string
  structured_output?: unknown
  duration_ms?: number
  total_cost_usd?: number
  usage?: { cache_read_input_tokens?: number; input_tokens?: number }
}

interface Session {
  id: string
  lastTurnId: number
  calls: number
  createdAt: number
}

function tryJson(text: string | undefined): unknown {
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

function runClaude(bin: string, args: string[]): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    // stdin は必ず閉じる(開いたままだと claude が 3 秒待って警告し、失敗することがある)
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: claudeWorkDir() })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`claude -p timeout ${TIMEOUT_MS}ms`)) }, TIMEOUT_MS)
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', e => { clearTimeout(timer); reject(new Error(`claude -p spawn failed: ${e.message}`)) })
    child.on('close', code => {
      clearTimeout(timer)
      // 非 0 でも stdout に結果 JSON が出ていれば、そこから理由を読む(max_turns 等)
      if (code === 0 || out.trim().startsWith('{')) {
        try { resolve(JSON.parse(out) as ClaudeResult) } catch { reject(new Error(`claude -p returned non-JSON: ${out.slice(0, 200)}`)) }
      } else {
        reject(new Error(`claude -p exit ${code}: ${(err || out).slice(0, 300)}`))
      }
    })
  })
}

function extract(mode: LlmMode, req: AnalyzeRequest, parsed: ClaudeResult): Analysis {
  const raw = parsed.structured_output ?? tryJson(parsed.result)
  if (!raw) {
    const why = parsed.terminal_reason ?? parsed.subtype ?? 'unknown'
    throw new Error(`claude -p: 構造化出力なし (${why}${parsed.is_error ? ', is_error' : ''}) ${String(parsed.result ?? '').slice(0, 200)}`)
  }
  return toAnalysis(mode, req, raw)
}

/**
 * @param mode full = 従来(全項目を LLM が出す)/ text = 文章だけ(数値は Jev。出力が短く速い)
 */
export function claudeCodeProvider(cfg: Config, log: (line: string) => void = console.log, mode: LlmMode = 'full'): LlmProvider {
  const sessions = new Map<string, Session>()
  const tag = mode === 'text' ? '[claude-code:text]' : '[claude-code]'

  const commonArgs = () => [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(jsonSchemaFor(mode)),
    '--model', cfg.claudeCodeModel,
    '--effort', cfg.claudeCodeEffort,
    '--tools', '',
    // 構造化出力はツール呼び出しとして実装されており、前置きに 1 ターン使うことがある。
    // 1 だと terminal_reason=max_turns で空振りするので余裕を持たせる(ツールは全部無効なので暴走しない)
    '--max-turns', '4',
  ]

  /** 新規セッション(または独立呼び出し)。memory + 直近 N 発話 */
  async function fresh(req: AnalyzeRequest, persist: boolean): Promise<{ analysis: Analysis; sessionId?: string; ms: number }> {
    const t0 = Date.now()
    const turns = req.turns.slice(-cfg.promptTurns)
    const args = [...commonArgs(), '--system-prompt', systemPromptFor(mode)]
    if (!persist) args.push('--no-session-persistence')
    args.push(userPromptFor(mode, req, turns))
    const r = await runClaude(cfg.claudeBin, args)
    return { analysis: extract(mode, req, r), sessionId: r.session_id, ms: Date.now() - t0 }
  }

  /** 既存セッションに新しい発話だけを追加 */
  async function resume(sess: Session, req: AnalyzeRequest, newTurns: TranscriptTurn[]): Promise<Analysis> {
    const args = [...commonArgs(), '--resume', sess.id, deltaPromptFor(mode, newTurns, req.previous)]
    const r = await runClaude(cfg.claudeBin, args)
    if (r.session_id && r.session_id !== sess.id) sess.id = r.session_id
    return extract(mode, req, r)
  }

  return {
    name: 'claude-code',
    async analyze(req: AnalyzeRequest): Promise<Analysis> {
      if (mode === 'text' && req.previous && req.turns.length === 0) return req.previous
      const key = req.sessionKey
      if (!cfg.claudeCodeSession || !key) {
        return (await fresh(req, false)).analysis
      }

      const lastId = req.turns.at(-1)?.id ?? 0
      const sess = sessions.get(key)
      const expired = sess && (sess.calls >= cfg.sessionMaxCalls || Date.now() - sess.createdAt > cfg.sessionMaxMinutes * 60_000)
      // 発話 ID が巻き戻った(アプリ側リセット)場合もセッションを作り直す
      const rewound = sess && lastId < sess.lastTurnId

      if (!sess || expired || rewound) {
        const reason = !sess ? 'new' : expired ? 'rotate' : 'rewound'
        const { analysis, sessionId, ms } = await fresh(req, true)
        if (sessionId) {
          sessions.set(key, { id: sessionId, lastTurnId: lastId, calls: 1, createdAt: Date.now() })
          log(`${tag} session ${reason} ${sessionId.slice(0, 8)} (${Math.min(req.turns.length, cfg.promptTurns)} turns, ${ms}ms)`)
        }
        return analysis
      }

      const newTurns = req.turns.filter(t => t.id > sess.lastTurnId)
      if (newTurns.length === 0 && req.previous) {
        // 新規発話なし: previous をそのまま返すのが最も安い
        return req.previous
      }
      const t0 = Date.now()
      try {
        const analysis = await resume(sess, req, newTurns.length ? newTurns : req.turns.slice(-1))
        sess.lastTurnId = lastId
        sess.calls++
        log(`${tag} resume ${sess.id.slice(0, 8)} +${newTurns.length} turns (${Date.now() - t0}ms, call ${sess.calls})`)
        return analysis
      } catch (e) {
        // セッションが消えた等 → 巻き直して復旧
        log(`${tag} resume failed (${(e as Error).message.slice(0, 120)}) → new session`)
        sessions.delete(key)
        const { analysis, sessionId } = await fresh(req, true)
        if (sessionId) sessions.set(key, { id: sessionId, lastTurnId: lastId, calls: 1, createdAt: Date.now() })
        return analysis
      }
    },
  }
}
