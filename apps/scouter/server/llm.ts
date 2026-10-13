// 状態解析プロバイダ。既定は Anthropic(claude-opus-5)。Node / Workers 共通。
import Anthropic from '@anthropic-ai/sdk'
import type { Analysis, AnalyzeRequest } from '../shared/types'
import type { Config } from './config'
import { hybridProvider, jevAvailable, jevProvider } from './jev'
import { mockAnalyze } from './mock'
import { systemPromptFor, userPromptFor } from './prompt'
import { jsonSchemaFor, normalizeAnalysis, toAnalysis, type LlmMode, zodFormatFor } from './schema'

export interface LlmProvider {
  name: string
  analyze(req: AnalyzeRequest): Promise<Analysis>
}
export type { LlmMode }

// ---------------- Anthropic ----------------
function anthropicProvider(cfg: Config, mode: LlmMode = 'full'): LlmProvider {
  // キーが無い場合は SDK の既定解決(ANTHROPIC_API_KEY / `ant auth login` プロファイル)に任せる
  const client = new Anthropic(cfg.anthropicKey ? { apiKey: cfg.anthropicKey } : {})
  return {
    name: 'anthropic',
    async analyze(req) {
      const format = zodFormatFor(mode)
      const base = {
        model: cfg.anthropicModel,
        max_tokens: 2048,
        system: [{ type: 'text' as const, text: systemPromptFor(mode), cache_control: { type: 'ephemeral' as const } }],
        messages: [{ role: 'user' as const, content: userPromptFor(mode, req, req.turns.slice(-cfg.promptTurns)) }],
      }
      // 安全分類による拒否時はサーバ側フォールバック("default")で別モデルに切り替える。
      // 非対応環境で 400 になった場合はフォールバック無しで再試行。
      let text: string
      try {
        const res = await client.beta.messages.create({
          ...base,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: cfg.anthropicEffort, format },
        })
        if (res.stop_reason === 'refusal') throw new Error('model refused')
        text = res.content.filter(b => b.type === 'text').map(b => b.text).join('')
      } catch (e) {
        if (!(e instanceof Anthropic.BadRequestError)) throw e
        const res = await client.messages.create({ ...base, output_config: { effort: cfg.anthropicEffort, format } })
        if (res.stop_reason === 'refusal') throw new Error('model refused')
        text = res.content.filter(b => b.type === 'text').map(b => b.text).join('')
      }
      return toAnalysis(mode, req, JSON.parse(text))
    },
  }
}

// ---------------- OpenAI ----------------
function openaiProvider(cfg: Config, mode: LlmMode = 'full'): LlmProvider {
  return {
    name: 'openai',
    async analyze(req) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.openaiKey}` },
        body: JSON.stringify({
          model: cfg.openaiLlmModel,
          messages: [
            { role: 'system', content: systemPromptFor(mode) },
            { role: 'user', content: userPromptFor(mode, req, req.turns.slice(-cfg.promptTurns)) },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'analysis', strict: true, schema: jsonSchemaFor(mode) } },
          temperature: 0.4,
        }),
      })
      if (!res.ok) throw new Error(`openai llm ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const text = json.choices?.[0]?.message?.content ?? ''
      return toAnalysis(mode, req, JSON.parse(text))
    },
  }
}

// ---------------- Gemini ----------------
function geminiProvider(cfg: Config, mode: LlmMode = 'full'): LlmProvider {
  return {
    name: 'gemini',
    async analyze(req) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.geminiLlmModel}:generateContent?key=${cfg.geminiKey}`
      // Gemini の responseSchema は additionalProperties を受け付けないので落とす
      const schema = JSON.parse(JSON.stringify(jsonSchemaFor(mode)), (k, v) => (k === 'additionalProperties' ? undefined : v))
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPromptFor(mode) }] },
          contents: [{ role: 'user', parts: [{ text: userPromptFor(mode, req, req.turns.slice(-cfg.promptTurns)) }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.4 },
        }),
      })
      if (!res.ok) throw new Error(`gemini llm ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
      const text = (json.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join('')
      return toAnalysis(mode, req, JSON.parse(text))
    },
  }
}

function mockProvider(mode: LlmMode = 'full'): LlmProvider {
  return {
    name: 'mock',
    async analyze(req) {
      await new Promise(r => setTimeout(r, 400))
      const a = normalizeAnalysis(mockAnalyze(req))
      return mode === 'text' ? toAnalysis('text', req, a) : a
    },
  }
}

export interface ExtraLlms {
  /** ランタイム固有のプロバイダ(Node の claude-code 等)。full = 従来の全項目出力、text = 文章だけ(Jev と組む) */
  full?: Record<string, LlmProvider>
  text?: Record<string, LlmProvider>
}

/** キーがある LLM を mode(full / text)で並べる */
export function baseLlms(cfg: Config, mode: LlmMode, extra: Record<string, LlmProvider> = {}): Record<string, LlmProvider> {
  const out: Record<string, LlmProvider> = { ...extra }
  if (cfg.anthropicHasCreds) out.anthropic = anthropicProvider(cfg, mode)
  if (cfg.openaiKey) out.openai = openaiProvider(cfg, mode)
  if (cfg.geminiKey) out.gemini = geminiProvider(cfg, mode)
  out.mock = mockProvider(mode)
  return out
}

/**
 * 今の設定で使えるプロバイダを全部並べる(/analyze?provider= の切り替えと比較スクリプト用)。
 * TYPESAFE_API_KEY があれば `jev`(判定のみ)と、各 LLM の文章モードとの合成 `jev+<name>` も加わる。
 */
export function availableLlms(cfg: Config, extra: ExtraLlms = {}): Record<string, LlmProvider> {
  const out = baseLlms(cfg, 'full', extra.full)
  if (jevAvailable(cfg)) {
    for (const llm of Object.values(baseLlms(cfg, 'text', extra.text))) out[`jev+${llm.name}`] = hybridProvider(cfg, llm)
    out.jev = jevProvider(cfg)
  }
  return out
}

/** LLM_PROVIDER の LLM 部分(jev+claude-code → claude-code、auto → 自動選択)を文章モードで返す。二段表示の text ステージ用 */
export function pickTextLlm(cfg: Config, extra: ExtraLlms = {}): LlmProvider {
  const want = cfg.llmProvider.replace(/^jev\+/, '')
  const all = baseLlms(cfg, 'text', extra.text)
  if (all[want]) return all[want]
  if (want === 'anthropic') return anthropicProvider(cfg, 'text')
  if (want === 'openai') return openaiProvider(cfg, 'text')
  if (want === 'gemini') return geminiProvider(cfg, 'text')
  const first = Object.values(extra.text ?? {})[0]
  if (first) return first
  if (cfg.anthropicHasCreds) return anthropicProvider(cfg, 'text')
  if (cfg.openaiKey) return openaiProvider(cfg, 'text')
  if (cfg.geminiKey) return geminiProvider(cfg, 'text')
  return mockProvider('text')
}

/**
 * LLM_PROVIDER に従って 1 つ選ぶ。auto は extra(claude-code)→ anthropic → openai → gemini → mock。
 * jev 系を明示してキーが無い時は起動時に落とす(黙って別プロバイダにしない)。
 */
export function pickLlm(cfg: Config, extra: ExtraLlms = {}): LlmProvider {
  const want = cfg.llmProvider
  const all = availableLlms(cfg, extra)
  if (all[want]) return all[want]
  if (want.startsWith('jev')) {
    if (!jevAvailable(cfg)) throw new Error(`LLM_PROVIDER=${want} には TYPESAFE_API_KEY が必要です(server/.env)`)
    throw new Error(`LLM_PROVIDER=${want}: 合成相手が見つかりません。使えるのは ${Object.keys(all).join(', ')}`)
  }
  // 明示指定でキーが無い場合は SDK 側の既定解決に任せる(従来動作)
  if (want === 'anthropic') return anthropicProvider(cfg)
  if (want === 'openai') return openaiProvider(cfg)
  if (want === 'gemini') return geminiProvider(cfg)
  const first = Object.values(extra.full ?? {})[0]
  if (first) return first
  if (cfg.anthropicHasCreds) return anthropicProvider(cfg)
  if (cfg.openaiKey) return openaiProvider(cfg)
  if (cfg.geminiKey) return geminiProvider(cfg)
  return mockProvider()
}
