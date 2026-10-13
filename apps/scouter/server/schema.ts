import { z } from 'zod'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { Analysis, AnalyzeRequest } from '../shared/types'
import { EMPTY_ANALYSIS, FACE_KINDS } from '../shared/types'

const pct = z.number().min(0).max(100)

export const AnalysisSchema = z.object({
  emotions: z.object({ joy: pct, anger: pct, sorrow: pct, pleasure: pct }),
  face: z.enum(FACE_KINDS),
  mood: z.string(),
  score: pct,
  scores: z.object({ engagement: pct, rapport: pct, openness: pct }),
  digDeeper: z.array(z.string()),
  suggestions: z.array(z.string()),
  summary: z.string(),
  memory: z.string().default(''),
})

/** 文章モード(数値は Jev が出す)で LLM に求める部分 */
export const TextSchema = z.object({
  digDeeper: z.array(z.string()),
  suggestions: z.array(z.string()),
  summary: z.string(),
  memory: z.string().default(''),
})
export type TextPart = z.infer<typeof TextSchema>

/** 文章モードの結果に数値(previous = Jev の判定)を合わせて Analysis にする */
export function withNumbers(req: AnalyzeRequest, t: TextPart): Analysis {
  const p = req.previous ?? EMPTY_ANALYSIS
  return normalizeAnalysis({ emotions: p.emotions, face: p.face, mood: p.mood, score: p.score, scores: p.scores, ...t })
}

/** 文字数・件数をグラスに収まる範囲へ丸める(LLM が守らなかった時の保険) */
export function normalizeAnalysis(a: Analysis): Analysis {
  const clip = (s: string, n: number) => [...s.replace(/\s+/g, ' ').trim()].slice(0, n).join('')
  const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)))
  return {
    emotions: {
      joy: clamp(a.emotions.joy),
      anger: clamp(a.emotions.anger),
      sorrow: clamp(a.emotions.sorrow),
      pleasure: clamp(a.emotions.pleasure),
    },
    face: a.face,
    mood: clip(a.mood, 6),
    score: clamp(a.score),
    scores: {
      engagement: clamp(a.scores.engagement),
      rapport: clamp(a.scores.rapport),
      openness: clamp(a.scores.openness),
    },
    digDeeper: a.digDeeper.filter(Boolean).slice(0, 3).map(s => clip(s, 30)),
    suggestions: a.suggestions.filter(Boolean).slice(0, 3).map(s => clip(s, 30)),
    summary: clip(a.summary, 40),
    memory: clip(a.memory ?? '', 140),
  }
}

/** JSON Schema(OpenAI / Gemini 用) */
export const ANALYSIS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['emotions', 'face', 'mood', 'score', 'scores', 'digDeeper', 'suggestions', 'summary', 'memory'],
  properties: {
    emotions: {
      type: 'object',
      additionalProperties: false,
      required: ['joy', 'anger', 'sorrow', 'pleasure'],
      properties: {
        joy: { type: 'number' }, anger: { type: 'number' }, sorrow: { type: 'number' }, pleasure: { type: 'number' },
      },
    },
    face: { type: 'string', enum: FACE_KINDS },
    mood: { type: 'string' },
    score: { type: 'number' },
    scores: {
      type: 'object',
      additionalProperties: false,
      required: ['engagement', 'rapport', 'openness'],
      properties: { engagement: { type: 'number' }, rapport: { type: 'number' }, openness: { type: 'number' } },
    },
    digDeeper: { type: 'array', items: { type: 'string' } },
    suggestions: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    memory: { type: 'string' },
  },
} as const

/** 文章モードの JSON Schema */
export const TEXT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['digDeeper', 'suggestions', 'summary', 'memory'],
  properties: {
    digDeeper: { type: 'array', items: { type: 'string' } },
    suggestions: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    memory: { type: 'string' },
  },
} as const

export type LlmMode = 'full' | 'text'
export const schemaFor = (mode: LlmMode) => (mode === 'text' ? TextSchema : AnalysisSchema)
export const jsonSchemaFor = (mode: LlmMode) => (mode === 'text' ? TEXT_JSON_SCHEMA : ANALYSIS_JSON_SCHEMA)
/** パース結果を Analysis に(文章モードは previous の数値を合わせる) */
export function toAnalysis(mode: LlmMode, req: AnalyzeRequest, raw: unknown): Analysis {
  return mode === 'text' ? withNumbers(req, TextSchema.parse(raw)) : normalizeAnalysis(AnalysisSchema.parse(raw))
}
export const zodFormatFor = (mode: LlmMode) => (mode === 'text' ? zodOutputFormat(TextSchema) : zodOutputFormat(AnalysisSchema))
