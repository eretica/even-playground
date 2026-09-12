// スマホ側(src)とプロキシ(server)で共有する型。

export type Speaker = 'self' | 'other' | 'unknown'

export interface TranscriptTurn {
  id: number
  speaker: Speaker
  text: string
  ts: number
}

export type FaceKind = 'neutral' | 'happy' | 'angry' | 'sad' | 'relaxed' | 'surprised' | 'tired'

export const FACE_KINDS: FaceKind[] = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised', 'tired']

/** 喜怒哀楽 0-100 */
export interface Emotions {
  joy: number
  anger: number
  sorrow: number
  pleasure: number
}

export interface Analysis {
  emotions: Emotions
  face: FaceKind
  /** 一言の状態ラベル(全角 6 文字以内) */
  mood: string
  /** 総合スコア 0-100(相手が会話を楽しめている度合い) */
  score: number
  scores: {
    engagement: number
    rapport: number
    openness: number
  }
  /** 深掘りすべき点(各 全角 24 文字以内、1-3 件) */
  digDeeper: string[]
  /** 次に言う一言の提案(各 全角 24 文字以内、1-3 件) */
  suggestions: string[]
  /** 会話の要約(1 文) */
  summary: string
  /** これまでの会話の要点(LLM が毎回更新する持ち越しメモ、全角 160 字以内) */
  memory: string
}

export interface AnalyzeRequest {
  turns: TranscriptTurn[]
  previous?: Analysis | null
  lang?: string
  /** 会話セッションの識別子(アプリ起動・リセットごとに変わる)。サーバ側のセッション継続に使う */
  sessionKey?: string
}

export type AnalyzeResponse =
  | { ok: true; analysis: Analysis; provider: string; ms: number }
  | { ok: false; error: string }

export type TranscribeResponse =
  | { ok: true; text: string; provider: string; ms: number }
  | { ok: false; error: string }

export interface HealthResponse {
  ok: true
  stt: string
  llm: string
  version: string
  /** サーバが Bearer トークンを要求するか */
  auth?: boolean
}

export const EMPTY_ANALYSIS: Analysis = {
  emotions: { joy: 0, anger: 0, sorrow: 0, pleasure: 0 },
  face: 'neutral',
  mood: '待機中',
  score: 0,
  scores: { engagement: 0, rapport: 0, openness: 0 },
  digDeeper: [],
  suggestions: [],
  summary: '',
  memory: '',
}
