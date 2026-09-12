import { z } from 'zod'
import type { Analysis } from '../shared/types'
import { FACE_KINDS } from '../shared/types'

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
