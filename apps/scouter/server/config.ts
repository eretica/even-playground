// 環境変数 → 設定。Node(process.env)でも Workers(env バインディング)でも同じ形にする。
export interface Config {
  sttProvider: string
  llmProvider: string
  sttLanguage: string
  openaiKey?: string
  geminiKey?: string
  anthropicKey?: string
  /** Node 側で `ant auth login` のプロファイルがある等、キー以外で Anthropic を使える場合 true */
  anthropicHasCreds: boolean
  openaiSttModel: string
  /** OpenAI 互換の文字起こしエンドポイント(ローカル whisper サーバ等に差し替え可) */
  openaiSttBaseUrl: string
  geminiSttModel: string
  /** ローカル whisper-server の OpenAI 互換ベース URL */
  whisperUrl: string
  anthropicModel: string
  anthropicEffort: 'low' | 'medium' | 'high'
  openaiLlmModel: string
  geminiLlmModel: string
  /** Claude Code(`claude -p`)を使う場合。Node 専用 */
  claudeBin: string
  claudeCodeModel: string
  claudeCodeEffort: string
  /** claude -p のセッション継続(--resume)を使うか */
  claudeCodeSession: boolean
  /** 1 セッションで許す呼び出し回数 / 分。超えたら memory + 直近発話で巻き直す */
  sessionMaxCalls: number
  sessionMaxMinutes: number
  /** 新規セッション・独立呼び出し時に渡す直近発話数 */
  promptTurns: number
  /** 設定されていれば /transcribe と /analyze に Bearer 認証を要求する */
  sharedSecret?: string
}

export type EnvLike = Record<string, string | undefined>

export function configFromEnv(env: EnvLike, opts: { anthropicHasCreds?: boolean } = {}): Config {
  const s = (k: string, d = '') => (env[k] ?? d).toString().trim()
  const effort = s('ANTHROPIC_EFFORT', 'low')
  return {
    sttProvider: s('STT_PROVIDER', 'auto').toLowerCase(),
    llmProvider: s('LLM_PROVIDER', 'auto').toLowerCase(),
    sttLanguage: s('STT_LANGUAGE', 'ja'),
    openaiKey: s('OPENAI_API_KEY') || undefined,
    geminiKey: s('GEMINI_API_KEY') || undefined,
    anthropicKey: s('ANTHROPIC_API_KEY') || undefined,
    anthropicHasCreds: Boolean(s('ANTHROPIC_API_KEY') || s('ANTHROPIC_AUTH_TOKEN') || opts.anthropicHasCreds),
    openaiSttModel: s('OPENAI_STT_MODEL', 'gpt-4o-mini-transcribe'),
    openaiSttBaseUrl: s('OPENAI_STT_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
    geminiSttModel: s('GEMINI_STT_MODEL', 'gemini-3.6-flash'),
    whisperUrl: s('WHISPER_URL', 'http://127.0.0.1:8178/v1').replace(/\/+$/, ''),
    anthropicModel: s('ANTHROPIC_MODEL', 'claude-opus-5'),
    anthropicEffort: (effort === 'medium' || effort === 'high' ? effort : 'low'),
    openaiLlmModel: s('OPENAI_LLM_MODEL', 'gpt-4o-mini'),
    geminiLlmModel: s('GEMINI_LLM_MODEL', 'gemini-3.6-flash'),
    claudeBin: s('CLAUDE_BIN', 'claude'),
    claudeCodeModel: s('CLAUDE_CODE_MODEL', 'sonnet'),
    claudeCodeEffort: s('CLAUDE_CODE_EFFORT', 'low'),
    claudeCodeSession: s('CLAUDE_CODE_SESSION', '1') !== '0',
    sessionMaxCalls: Number(s('SESSION_MAX_CALLS', '40')) || 40,
    sessionMaxMinutes: Number(s('SESSION_MAX_MINUTES', '30')) || 30,
    promptTurns: Number(s('PROMPT_TURNS', '10')) || 10,
    sharedSecret: s('SHARED_SECRET') || undefined,
  }
}
