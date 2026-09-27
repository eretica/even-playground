// Jev(TypeSafe AI)を「判定エンジン」として使う。文章を一切生成しない判定専用モデルで、
// 選択(choice)/ 順序尺度の採点(score)/ 真偽(noul)を確率付きで返す。1 回 100〜500ms、入力 100 万トークン 0.042 ドル。
// LLM の置き換えではなく、数値判定を速く・安く回し、文章(助言・要約・memory)は LLM に残す構成が本線。
//
//   jevJudge        相手の状態(喜怒哀楽・顔・mood・スコア群)を 1 リクエストで並列判定 → Analysis の数値部分
//   jevProvider     判定だけの LlmProvider(文章欄は空)。速度と判定の素の実力を見る用(LLM_PROVIDER=jev)
//   hybridProvider  Jev の判定 + LLM の文章を並列に取って合成(LLM_PROVIDER=jev+claude-code 等)
//   jevGate         文字起こしが「実発話か」を noul で判定し、幻聴・雑音を捨てる(STT_GATE=jev)
//
// 公式の弱点(jaggedness): 字義通りに読む(皮肉に弱い)、state が大きいと精度低下、基準が曖昧な score は外す。
// → state は直近 JEV_TURNS 発話 + memory に絞り、score の各段階に具体的な説明を付ける。
import { TypeSafeClient, choice, noul, score } from '@typesafe-ai/sdk'
import type { Analysis, AnalyzeRequest, FaceKind } from '../shared/types'
import type { Config } from './config'
import type { LlmProvider } from './llm'
import { normalizeAnalysis } from './schema'

const JUDGE_TIMEOUT_MS = 8000
const GATE_TIMEOUT_MS = 3000

export function jevAvailable(cfg: Config): boolean {
  return Boolean(cfg.typesafeKey)
}

function client(cfg: Config, timeout: number, maxRetries: number): TypeSafeClient {
  if (!cfg.typesafeKey) throw new Error('TYPESAFE_API_KEY が未設定です(server/.env)。Jev は https://typesafe.ai の waitlist か Vercel AI Gateway でキーを取得')
  return new TypeSafeClient({
    apiKey: cfg.typesafeKey,
    ...(cfg.typesafeBaseUrl ? { baseURL: cfg.typesafeBaseUrl } : {}),
    defaultModel: cfg.jevModel,
    timeout,
    retry: { maxRetries },
    logLevel: 'error',
  })
}

// ---------------- 判定(状態解析の数値部分) ----------------

/** 5 段階の順序尺度。Jev の score は期待値(0〜4 の実数)で返るので ×25 して 0-100 にする */
const LEVELS = (none: string, weak: string, some: string, clear: string, strong: string) => [none, weak, some, clear, strong] as const
const toPct = (s: number) => Math.max(0, Math.min(100, Math.round((s / 4) * 100)))

const EMOTION_LEVELS = LEVELS('全く見られない', 'わずかに感じられる', 'ある程度ある', 'はっきり出ている', '非常に強い')

/** グラスに出す一言(全角 6 文字以内)。Jev は文章を作れないので、候補から選ばせる */
export const MOODS = {
  上機嫌: '明るく楽しそうに話している',
  乗り気: '話題に前向きで、自分から話を広げている',
  落ち着き: '穏やかでリラックスして話している',
  様子見: '情報が少ない、または本音を出さず慎重に会話している',
  警戒気味: '距離を取り、身構えている・警戒している',
  退屈そう: '関心が薄く、反応が淡い・短い',
  お疲れ: '疲労や消耗がにじんでいる',
  苛立ち: '不満・怒り・苛立ちが出ている',
  沈み気味: '落ち込み・悲しみ・寂しさが出ている',
  驚き: '意外な情報に驚いている',
} as const

const FACES: Record<FaceKind, string> = {
  neutral: '平常・特に感情が出ていない',
  happy: '嬉しい・笑顔',
  angry: '怒り・不満',
  sad: '悲しい・落ち込み',
  relaxed: 'くつろぎ・穏やか',
  surprised: '驚き',
  tired: '疲れ・消耗',
}

function buildQuestions() {
  const emotion = (name: string, desc: string) => score(`相手(other)の「${name}」(${desc})は、今どの程度か`, EMOTION_LEVELS)
  return {
    joy: emotion('喜', '嬉しさ・喜び'),
    anger: emotion('怒', '怒り・不満・苛立ち'),
    sorrow: emotion('哀', '悲しみ・落ち込み・寂しさ'),
    pleasure: emotion('楽', '楽しさ・くつろぎ・心地よさ'),
    face: choice('今の相手(other)に最も近い表情はどれか', FACES),
    mood: choice('今の相手(other)の状態を表す一言として最も合うものはどれか', MOODS),
    enjoy: score('相手(other)はこの会話をどの程度楽しめているか', LEVELS('全く楽しめていない', 'あまり楽しめていない', '普通', 'かなり楽しんでいる', 'とても楽しんでいる')),
    engagement: score('相手(other)の会話への関心・食いつきはどの程度か', LEVELS('無関心・反応がない', '薄い・短い返事だけ', '普通に応じている', '積極的に話している', '自分から話を広げ質問もしている')),
    rapport: score('相手(other)と装着者(self)の親密さ・信頼はどの程度か', LEVELS('よそよそしい・警戒', 'ややかしこまっている', '普通', '打ち解けている', '非常に親しく信頼している')),
    openness: score('相手(other)は本音・個人的な事情をどの程度出しているか', LEVELS('全く出していない', '当たり障りのない話だけ', '少し個人的な話がある', '本音や事情を話している', '弱みや深い感情まで話している')),
  }
}

/** Jev に渡す state。大きすぎると精度が落ちるので直近 N 発話 + memory + 前回の要約だけ */
export function buildJevState(req: AnalyzeRequest, turns: number) {
  return {
    task: '装着者(self)が相手(other)と対面で会話している。音声の文字起こしなので誤認識が混ざる(不自然な単語は文脈で読む)。判定対象は相手(other)の「現在の」状態。self の発話は相手の反応を読む文脈としてだけ使う。unknown は話者不明。',
    memory: req.previous?.memory || null,
    previous: req.previous ? { face: req.previous.face, mood: req.previous.mood, score: req.previous.score } : null,
    conversation: req.turns.slice(-turns).map(t => `${t.speaker}: ${t.text}`).join('\n') || '(まだ発話なし)',
  }
}

export interface JevJudgement {
  emotions: Analysis['emotions']
  face: FaceKind
  mood: string
  score: number
  scores: Analysis['scores']
  /** 各判定の確率分布(比較・デバッグ用)。score 系はレベル別、choice 系はラベル別 */
  probabilities: Record<string, Record<string, number>>
  confidence: Record<string, number>
  model: string
  usage: { input_tokens: number; output_tokens: number }
  ms: number
}

export async function jevJudge(cfg: Config, req: AnalyzeRequest): Promise<JevJudgement> {
  const t0 = Date.now()
  const c = client(cfg, JUDGE_TIMEOUT_MS, 1)
  const questions = buildQuestions()
  const { answers, model, usage } = await c.systemOne({ state: buildJevState(req, cfg.jevTurns), questions })
  const probabilities: Record<string, Record<string, number>> = {}
  const confidence: Record<string, number> = {}
  for (const [k, a] of Object.entries(answers)) {
    probabilities[k] = Object.fromEntries(Object.entries(a.probabilities).map(([l, p]) => [l, Math.round(Number(p) * 1000) / 1000]))
    confidence[k] = Math.round(a.confidence * 1000) / 1000
  }
  const face = answers.face.choice
  return {
    emotions: { joy: toPct(answers.joy.score), anger: toPct(answers.anger.score), sorrow: toPct(answers.sorrow.score), pleasure: toPct(answers.pleasure.score) },
    face: face in FACES ? face : 'neutral',
    mood: answers.mood.choice,
    score: toPct(answers.enjoy.score),
    scores: { engagement: toPct(answers.engagement.score), rapport: toPct(answers.rapport.score), openness: toPct(answers.openness.score) },
    probabilities,
    confidence,
    model,
    usage,
    ms: Date.now() - t0,
  }
}

export interface JevLlmProvider extends LlmProvider {
  /** 直近の生の判定(確率分布込み)。比較スクリプトが読む */
  last?: JevJudgement
}

/** 判定だけ。文章欄(digDeeper / suggestions / summary)は空。memory は直近の相手の発話を機械的に繋ぐ */
export function jevProvider(cfg: Config): JevLlmProvider {
  const p: JevLlmProvider = {
    name: 'jev',
    async analyze(req) {
      const j = await jevJudge(cfg, req)
      p.last = j
      const others = req.turns.filter(t => t.speaker !== 'self').slice(-5)
      return normalizeAnalysis({
        emotions: j.emotions,
        face: j.face,
        mood: j.mood,
        score: j.score,
        scores: j.scores,
        digDeeper: [],
        suggestions: [],
        summary: '(Jev: 判定のみ・文章なし)',
        memory: others.map(t => t.text.replace(/[。、！？!?]/g, '').slice(0, 14)).join(' / '),
      })
    },
  }
  return p
}

/** Jev(数値判定)と LLM(文章)を並列に呼び、数値は Jev・文章と memory は LLM から取る。どちらかが失敗したら失敗(無言のフォールバックはしない) */
export function hybridProvider(cfg: Config, llm: LlmProvider): JevLlmProvider {
  const p: JevLlmProvider = {
    name: `jev+${llm.name}`,
    async analyze(req) {
      const [j, a] = await Promise.all([jevJudge(cfg, req), llm.analyze(req)])
      p.last = j
      return { ...a, emotions: j.emotions, face: j.face, mood: j.mood, score: j.score, scores: j.scores }
    },
  }
  return p
}

// ---------------- STT ゲート(幻聴・雑音の除去) ----------------

export interface GateResult {
  keep: boolean
  /** 「実発話である」確率 0-1 */
  p: number
  ms: number
}

export interface JevGate {
  name: string
  check(text: string, speaker: string): Promise<GateResult>
}

export function jevGate(cfg: Config): JevGate {
  const c = client(cfg, GATE_TIMEOUT_MS, 0)
  const question = noul(
    'この文字列は、人同士の対面会話の中で実際に話された発話を文字起こししたものとして自然か',
    {
      true: '会話の一部として意味が通る発話。短い相槌・言いかけ・雑談・質問も含む',
      false: '動画字幕の定型句(ご視聴ありがとうございました、チャンネル登録 等)、同じ語の無意味な繰り返し、雑音由来の断片、記号や擬音だけ、意味を成さない文字列',
    },
  )
  return {
    name: 'jev',
    async check(text, speaker) {
      const t0 = Date.now()
      const { answers } = await c.systemOne({ state: { speaker, text }, questions: { speech: question } })
      const p = answers.speech.noul
      return { keep: p >= cfg.jevGateThreshold, p, ms: Date.now() - t0 }
    },
  }
}
