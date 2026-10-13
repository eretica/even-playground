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

/**
 * 解析ステージ(二段表示)。
 *   fast = Jev の数値判定だけ(0.2 秒)。文章欄は previous を引き継ぐ
 *   text = LLM の文章だけ(数値は previous = Jev の判定を前提に書く)
 *   full = 従来(1 回で全部。Jev があれば数値は Jev、文章は LLM を並列)
 */
export type AnalyzeStage = 'fast' | 'text' | 'full'

export type AnalyzeResponse =
  | { ok: true; analysis: Analysis; provider: string; ms: number; stage?: AnalyzeStage; /** Jev の判定で前回値を保持した項目 */ held?: string[] }
  | { ok: false; error: string }

export type TranscribeResponse =
  | { ok: true; text: string; provider: string; ms: number; /** ゲート(STT_GATE=jev)の判定メモ。捨てた時は text が空になる */ note?: string }
  | { ok: false; error: string }

export interface HealthResponse {
  ok: true
  stt: string
  llm: string
  version: string
  /** サーバが Bearer トークンを要求するか */
  auth?: boolean
  /** /analyze?provider= で選べるプロバイダ名(サーバ側で使える組み合わせ)。比較用 */
  llmOptions?: string[]
  /** /transcribe 後のゲート(off | jev) */
  sttGate?: string
  /** 二段表示(fast = Jev → text = LLM)が使えるか(= Jev のキーがある) */
  twoStage?: boolean
  /** text ステージで使う LLM 名 */
  textLlm?: string
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
