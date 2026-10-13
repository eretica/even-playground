// Jev(TypeSafe AI)を「判定エンジン」として使う。文章を一切生成しない判定専用モデルで、
// 選択(choice)/ 順序尺度の採点(score)/ 真偽(noul)を較正済みの確率付きで返す。1 回 0.2 秒、入力 100 万トークン 0.042 ドル。
// LLM の置き換えではなく、数値判定を速く・安く回し、文章(助言・要約・memory)は LLM に残す構成。
//
//   jevJudge        相手の状態(喜怒哀楽・顔・mood・スコア群)を 1 リクエストで並列判定 → Analysis の数値部分
//   jevProvider     判定だけの LlmProvider(文章欄は空)。速度と判定の素の実力を見る用(LLM_PROVIDER=jev)
//   hybridProvider  Jev の判定 + LLM(文章モード)を並列に取って合成(LLM_PROVIDER=jev+claude-code 等)
//   jevGate         文字起こしが「実発話か」を noul で判定し、幻聴・雑音を捨てる(STT_GATE=jev)
//
// 質問設計の方針(公式の弱点一覧と実装パターン集に従う):
//   - Jev は字義通りに読む → 各段階・各選択肢を「観察できる状況」で書く。曖昧な形容詞(「ややある」)は使わない
//   - 選択肢は what / not_for で隣接候補との境界を切る(疲れ vs 沈み、落ち着き vs 様子見)
//   - state は直近 JEV_TURNS 発話 + memory だけ。前回の face/mood は渡さない(引きずって固着する)
//   - 合成値(総合 score)は Jev に聞かずコードで計算する(「コードが計算し、Jev が判定する」)
//   - confidence が低い判定は前回の値を保持(ヒステリシス)。較正されているので閾値に意味がある
//   - 利用できるモデル名は jev-latest / jev-preview のみで版の固定はできない。応答の model 名をログに残し、
//     scripts/eval-jev.ts の評価セットで更新時の変化を検知する
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
  if (!cfg.typesafeKey) throw new Error('TYPESAFE_API_KEY が未設定です(server/.env)。Jev は https://typesafe.ai の waitlist でキーを取得')
  return new TypeSafeClient({
    apiKey: cfg.typesafeKey,
    ...(cfg.typesafeBaseUrl ? { baseURL: cfg.typesafeBaseUrl } : {}),
    defaultModel: cfg.jevModel,
    timeout,
    retry: { maxRetries },
    logLevel: 'error',
  })
}

// ---------------- 質問の定義 ----------------

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)))
/** 4 段階(0〜3)の順序尺度。Jev の score は期待値(実数)なので /3 で 0-100 にする */
const L4 = (l0: string, l1: string, l2: string, l3: string) => [l0, l1, l2, l3] as const
const toPct = (s: number) => clamp((s / 3) * 100)

const TARGET = '相手(other)の最新発話 latest_other を最重視し、conversation はその文脈として読む。'

/** グラスに出す一言(全角 6 文字以内)。Jev は文章を作れないので候補から選ばせる。what / not_for で境界を切る */
export const MOODS = {
  上機嫌: { what: '笑い・喜び・嬉しさの言葉がはっきりある', not_for: '話題に前向きなだけで喜びの表現はない(→乗り気)' },
  乗り気: { what: '自分から話題を広げ、質問を返し、前向きに話している', not_for: '笑いや喜びの表現が主(→上機嫌)' },
  落ち着き: { what: '穏やかでゆったりした話し方。「落ち着く」「ほっとする」など', not_for: '発話が少なく判断材料がない(→様子見)' },
  様子見: { what: '短い返事や当たり障りのない内容で、気持ちが読めない。発話がまだ少ない', not_for: '質問をかわす・距離を取る意図が見える(→警戒)' },
  警戒: { what: '質問をかわす、話題を避ける、断る、距離を取る言い方', not_for: '単に返事が短いだけ(→様子見)' },
  退屈: { what: '相槌だけ、話題への無関心、気のない返事', not_for: '疲れや眠気を自分で訴えている(→疲れ)' },
  疲れ: { what: '疲労・眠気・消耗を自分の言葉で訴えている', not_for: '悲しみや落ち込みの言葉(→沈み)、不満の言葉(→苛立ち)' },
  苛立ち: { what: '不満・怒り・拒絶の言葉(「もういい」「ひどい」「やめて」)', not_for: '疲労の訴え(→疲れ)' },
  沈み: { what: '悲しみ・落ち込み・寂しさ・喪失の言葉', not_for: '疲労の訴え(→疲れ)' },
  驚き: { what: '意外な情報への反応(「え、本当?」「まさか」)', not_for: '喜びの感嘆(→上機嫌)' },
} as const

const FACES: Record<FaceKind, { what: string; not_for: string }> = {
  neutral: { what: '感情の表現が特にない、事務的・淡々とした発話。判断材料が少ない時もこれ', not_for: '何らかの感情語がはっきりある場合' },
  happy: { what: '笑い・喜び・楽しさの言葉がある', not_for: '穏やかにくつろいでいるだけ(→relaxed)' },
  angry: { what: '不満・苛立ち・拒絶の言葉がある', not_for: '疲労の訴え(→tired)' },
  sad: { what: '悲しみ・落ち込み・寂しさの言葉がある', not_for: '疲労の訴え(→tired)' },
  relaxed: { what: '穏やか・くつろぎ・「落ち着く」「ほっとする」', not_for: 'はっきりした喜びの表現(→happy)' },
  surprised: { what: '意外な情報への驚きの反応(「え、本当?」)', not_for: '喜びの感嘆(→happy)' },
  tired: { what: '疲れ・眠気・消耗を自分の言葉で訴えている', not_for: '悲しみの言葉(→sad)' },
}

function buildQuestions() {
  return {
    joy: score(`${TARGET}喜び・嬉しさの表現はどの程度あるか`, L4(
      '喜びの表現がない',
      '軽い肯定や満足(「いいですね」「よかった」程度)',
      '明確な喜び。笑い、「楽しかった」「嬉しい」という報告',
      '強い喜び。感嘆や「最高」「待ち遠しい」など高揚した言葉を繰り返す',
    )),
    anger: score(`${TARGET}不満・怒り・苛立ちの表現はどの程度あるか`, L4(
      '不満・怒りの表現がない',
      '軽い不満や愚痴(「ひどい」「困る」)',
      '明確な苛立ちや拒絶(「もういい」「やめて」)',
      '強い怒り。攻撃的・侮辱的な言葉',
    )),
    sorrow: score(`${TARGET}悲しみ・落ち込み・寂しさの表現はどの程度あるか`, L4(
      '悲しみ・落ち込みの表現がない',
      '軽い落胆(「残念」「がっかり」)',
      '明確な悲しみ・寂しさ・喪失の話',
      '深い落ち込み。涙や絶望的な言葉',
    )),
    pleasure: score(`${TARGET}楽しさ・心地よさ・くつろぎの表現はどの程度あるか`, L4(
      '楽しさ・心地よさの表現がない',
      'ややくつろいでいる(「落ち着く」「ほっとする」)',
      '明確に楽しんでいる。趣味や遊びを楽しそうに話す',
      '夢中・没頭。時間を忘れるほど熱中している',
    )),
    face: choice(`${TARGET}今の相手(other)に最も近い表情はどれか。各選択肢の what に当てはまり not_for に当てはまらないものを選ぶ`, FACES),
    mood: choice(`${TARGET}今の相手(other)の状態を表す一言として最も合うものはどれか。各選択肢の what に当てはまり not_for に当てはまらないものを選ぶ`, MOODS),
    engagement: score(`${TARGET}相手(other)の会話への関心・食いつきはどの段階か`, L4(
      '反応がない、または相槌だけで話題に触れない',
      '聞かれたことに短く答えるだけ',
      '自分の言葉で話を続け、具体的な内容を話す',
      '自分から話題を広げ、装着者(self)に質問も返す',
    )),
    rapport: score(`${TARGET}相手(other)と装着者(self)の親密さ・信頼はどの段階か`, L4(
      'よそよそしい。距離を保つ、話をかわす',
      '丁寧だが事務的',
      '打ち解けた口調。冗談や本音の片鱗がある',
      '親しい間柄の話し方。弱みや個人的な事情を気軽に話す',
    )),
    openness: score(`${TARGET}相手(other)はどの程度本音・個人的な事情を出しているか`, L4(
      '当たり障りのない話だけ(天気・一般論)',
      '事実は話すが気持ちは言わない',
      '自分の気持ち・意見・事情を話している',
      '本音・弱み・深い感情まで話している',
    )),
  }
}

/** Jev に渡す state。大きすぎると精度が落ちるので直近 N 発話 + memory だけ。前回の face/mood は渡さない(引きずって固着する) */
export function buildJevState(req: AnalyzeRequest, turns: number) {
  return {
    task: '装着者(self)が相手(other)と対面で会話している。音声の文字起こしなので誤認識が混ざる(不自然な単語は文脈で読む)。判定対象は相手(other)の「今この瞬間」の状態。話題が変わったら古い発話の感情は引き継がない。self の発話は相手の反応を読む文脈としてだけ使う。unknown は話者不明で、相手(other)の発話として扱う。',
    // 話者判定が unknown だらけ(シミュレータ、実機でも推定失敗時)でも判定対象を失わないよう、self 以外の最新発話を使う
    latest_other: [...req.turns].reverse().find(t => t.speaker !== 'self')?.text ?? null,
    conversation: req.turns.slice(-turns).map(t => `${t.speaker}: ${t.text}`).join('\n') || '(まだ発話なし)',
    memory: req.previous?.memory || null,
    previous_score: req.previous?.score ?? null,
  }
}

/** 総合スコア(相手がこの会話を楽しめている度合い)。Jev に聞かず、判定値からコードで合成する(検査・調整しやすい) */
export function compositeScore(j: { emotions: Analysis['emotions']; scores: Analysis['scores'] }): number {
  const e = j.emotions
  const valence = clamp(50 + (e.joy + e.pleasure) / 4 - (e.anger + e.sorrow) / 4)
  return clamp(0.4 * j.scores.engagement + 0.3 * j.scores.rapport + 0.3 * valence)
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
  /** ヒステリシスで前回の値を保持した項目 */
  held: string[]
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
  const emotions = { joy: toPct(answers.joy.score), anger: toPct(answers.anger.score), sorrow: toPct(answers.sorrow.score), pleasure: toPct(answers.pleasure.score) }
  const scores = { engagement: toPct(answers.engagement.score), rapport: toPct(answers.rapport.score), openness: toPct(answers.openness.score) }
  const face: FaceKind = answers.face.choice in FACES ? answers.face.choice : 'neutral'
  const j: JevJudgement = {
    emotions, scores, face, mood: answers.mood.choice, score: compositeScore({ emotions, scores }),
    probabilities, confidence, held: [], model, usage, ms: 0,
  }
  applyHysteresis(j, req.previous, cfg.jevMinConfidence)
  j.ms = Date.now() - t0
  return j
}

/** 前回の値がまだ有力候補と言える確率の下限。これ未満なら confidence が低くても今回の判定に切り替える(古い値を引きずらない) */
const HOLD_MIN_PROB = 0.2

/**
 * confidence が閾値未満の face / mood は前回の値を保持する(表示のチラつきと、根拠の薄い切り替えを防ぐ)。
 * ただし前回の値が今回の分布でほぼ消えている(確率 < HOLD_MIN_PROB)なら保持しない。
 * 例: 前回「上機嫌」、今回「警戒 53% / 様子見 43%」→ confidence は低いが上機嫌は 0% なので警戒に切り替える
 */
export function applyHysteresis(j: JevJudgement, previous: Analysis | null | undefined, minConfidence: number): void {
  if (!previous || !previous.score) return
  const hold = (key: 'face' | 'mood', prevValue: string) =>
    j.confidence[key] < minConfidence && j[key] !== prevValue && (j.probabilities[key]?.[prevValue] ?? 0) >= HOLD_MIN_PROB
  if (hold('face', previous.face)) { j.face = previous.face; j.held.push('face') }
  if (previous.mood in MOODS && hold('mood', previous.mood)) { j.mood = previous.mood; j.held.push('mood') }
}

export interface JevLlmProvider extends LlmProvider {
  /** 直近の生の判定(確率分布込み)。比較スクリプトが読む */
  last?: JevJudgement
}

/** 判定だけ。文章欄は前回のものを引き継ぐ(無ければ空)。memory は直近の相手の発話を機械的に繋ぐ */
export function jevProvider(cfg: Config): JevLlmProvider {
  const p: JevLlmProvider = {
    name: 'jev',
    async analyze(req) {
      const j = await jevJudge(cfg, req)
      p.last = j
      const prev = req.previous
      const others = req.turns.filter(t => t.speaker !== 'self').slice(-5)
      return normalizeAnalysis({
        emotions: j.emotions,
        face: j.face,
        mood: j.mood,
        score: j.score,
        scores: j.scores,
        digDeeper: prev?.digDeeper ?? [],
        suggestions: prev?.suggestions ?? [],
        summary: prev?.summary ?? '',
        memory: prev?.memory || others.map(t => t.text.replace(/[。、！？!?]/g, '').slice(0, 14)).join(' / '),
      })
    },
  }
  return p
}

/** Jev(数値判定)と LLM(文章モード)を並列に呼び、数値は Jev・文章と memory は LLM から取る。どちらかが失敗したら失敗(無言のフォールバックはしない) */
export function hybridProvider(cfg: Config, textLlm: LlmProvider): JevLlmProvider {
  const p: JevLlmProvider = {
    name: `jev+${textLlm.name}`,
    async analyze(req) {
      const [j, a] = await Promise.all([jevJudge(cfg, req), textLlm.analyze(req)])
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
    'state.text は、人同士の対面会話の中で実際に話された発話を文字起こししたものとして自然か',
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
