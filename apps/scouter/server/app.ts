// ルーティング本体。Web 標準の Request/Response だけで書き、Node(index.ts)と Workers(worker.ts)から呼ぶ。
//   GET  /health                       → 使用中のプロバイダ(認証不要)
//   POST /transcribe?speaker=&lang=    → body: PCM s16le 16kHz mono → { text }
//   POST /analyze                      → body: AnalyzeRequest(JSON) → { analysis }
// SHARED_SECRET が設定されていれば POST 系は `Authorization: Bearer <secret>` 必須。
import type { AnalyzeRequest, AnalyzeResponse, HealthResponse, TranscribeResponse } from '../shared/types'
import type { Config } from './config'
import { pickLlm, type LlmProvider } from './llm'
import { pickStt, rmsOf, type SttProvider } from './stt'

export const VERSION = '0.2.0'
const SILENCE_RMS = 300

export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  })
}

export interface App {
  stt: SttProvider
  llm: LlmProvider
  cfg: Config
  handle(req: Request): Promise<Response>
}

export function createApp(cfg: Config, opts: { log?: (line: string) => void; extraLlm?: Record<string, LlmProvider> } = {}): App {
  const log = opts.log ?? console.log
  const stt = pickStt(cfg)
  const llm = pickLlm(cfg, opts.extraLlm ?? {})

  function authorized(req: Request): boolean {
    if (!cfg.sharedSecret) return true
    const h = req.headers.get('authorization') ?? ''
    return h === `Bearer ${cfg.sharedSecret}`
  }

  async function handle(req: Request): Promise<Response> {
    const t0 = Date.now()
    const url = new URL(req.url)
    const done = (status: number, note = '') =>
      log(`[${new Date().toISOString().slice(11, 19)}] ${req.method} ${url.pathname} → ${status} ${Date.now() - t0}ms ${note}`)

    try {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

      if (req.method === 'GET' && url.pathname === '/health') {
        const body: HealthResponse = { ok: true, stt: stt.name, llm: llm.name, version: VERSION, auth: Boolean(cfg.sharedSecret) }
        done(200)
        return json(200, body)
      }

      if (req.method === 'POST' && !authorized(req)) {
        done(401)
        return json(401, { ok: false, error: 'unauthorized: set the same token in the app settings (SHARED_SECRET)' })
      }

      if (req.method === 'POST' && url.pathname === '/transcribe') {
        const pcm = new Uint8Array(await req.arrayBuffer())
        const lang = url.searchParams.get('lang') || cfg.sttLanguage
        const speaker = url.searchParams.get('speaker') || 'unknown'
        const rms = rmsOf(pcm)
        if (pcm.byteLength < 16000 || rms < SILENCE_RMS) {
          const body: TranscribeResponse = { ok: true, text: '', provider: stt.name, ms: Date.now() - t0 }
          done(200, `skip (${pcm.byteLength}B rms=${Math.round(rms)})`)
          return json(200, body)
        }
        const text = await stt.transcribe(pcm, lang)
        const body: TranscribeResponse = { ok: true, text, provider: stt.name, ms: Date.now() - t0 }
        done(200, `${speaker} ${pcm.byteLength}B rms=${Math.round(rms)} → "${text.slice(0, 60)}"`)
        return json(200, body)
      }

      if (req.method === 'POST' && url.pathname === '/analyze') {
        const reqBody = (await req.json()) as AnalyzeRequest
        if (!Array.isArray(reqBody.turns)) throw new Error('turns must be an array')
        const analysis = await llm.analyze(reqBody)
        const body: AnalyzeResponse = { ok: true, analysis, provider: llm.name, ms: Date.now() - t0 }
        done(200, `${reqBody.turns.length} turns → face=${analysis.face} score=${analysis.score}`)
        return json(200, body)
      }

      done(404)
      return json(404, { ok: false, error: `no route: ${req.method} ${url.pathname}` })
    } catch (e) {
      const msg = (e as Error).message ?? String(e)
      // 上流(STT/LLM)のレート制限はそのまま 429 で返し、クライアントがバックオフできるようにする
      const status = /\b429\b|RESOURCE_EXHAUSTED|rate limit/i.test(msg) ? 429 : 500
      done(status, msg)
      return json(status, { ok: false, error: msg })
    }
  }

  return { stt, llm, cfg, handle }
}
