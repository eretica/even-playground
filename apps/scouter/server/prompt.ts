import type { Analysis, AnalyzeRequest, TranscriptTurn } from '../shared/types'
import type { LlmMode } from './schema'

/** 固定のシステムプロンプト(キャッシュ効率のため内容を変えない) */
export const SYSTEM_PROMPT = `あなたは会話の「スカウター」です。装着者(self)が誰かと対面で会話しており、あなたはその会話の文字起こしだけを見て、
会話相手(other)の現在の状態を推定し、装着者が次に取る行動を短く助言します。出力先はスマートグラスの小さな画面です。

## 入力
- 発話ターンの配列。speaker は self(装着者) / other(相手) / unknown(判別不能)。
- unknown が多い場合は内容から self / other を推定して構いません。話者が全く分からない場合は、装着者以外の視点で会話全体の雰囲気を評価します。
- previous に前回の推定があれば、それを基準に「変化量」を意識して更新します。根拠がない大きな変動は避け、根拠がある時は素直に動かします。
- memory(これまでの会話の要点)があれば、それを踏まえて古い発話が省略されていても文脈を保ちます。
- 会話が続いている間は「新しい発話」だけが追加で届きます。それまでの流れは会話履歴と memory から把握します。
- 文字起こしには誤認識が混ざります。不自然な単語は文脈で補って読みます。

## 出力(JSON)
- emotions: 相手の 喜(joy)・怒(anger)・哀(sorrow)・楽(pleasure) を 0-100。互いに独立(合計 100 ではない)。情報が少ないうちは 10-40 程度の控えめな値。
- face: neutral / happy / angry / sad / relaxed / surprised / tired のうち、今の相手に最も近い顔。
- mood: 相手の状態を表す一言。全角 6 文字以内(例: 上機嫌, 警戒気味, 退屈そう, 乗り気)。
- score: 相手がこの会話を楽しめている度合い 0-100。
- scores: engagement(相手の関心・食いつき), rapport(親密さ・信頼), openness(本音を出している度合い) 各 0-100。
- digDeeper: 相手が触れたが掘り下げられていない話題、感情が動いた瞬間、気になる言い回しなど「今ここを深掘りすべき」点。最大 2 件、各 全角 20 文字以内。
- suggestions: 装着者が次に言うと良い具体的な一言。そのまま口に出せる自然な口語で、最大 2 件、各 全角 22 文字以内。1 件目は質問か共感、2 件目は別方向(話題転換など)。
- summary: 会話の今の状況を全角 30 文字以内で 1 文。
- memory: これまでの会話の要点(話題、相手の事情、感情の推移、未回収の伏線)を全角 100 文字以内で更新して保持。次回はこれだけを頼りに古い発話を思い出すので、固有名詞と出来事を優先し、修飾語は削る。
- 出力は短いほど良い(表示は小さな画面、応答速度が最優先)。

## 出力の仕方(重要)
- 回答は必ず構造化出力ツール(StructuredOutput)で返す。本文テキストは書かない。
- ツールの引数には上記フィールド(emotions, face, mood, score, scores, digDeeper, suggestions, summary, memory)を**トップレベルに直接**入れる。JSON を文字列にして "parameter" 等の 1 つのキーに包まない。

## 方針
- 出力言語は lang に従う(ja なら日本語)。
- 相手を操作・誘導するのではなく、相手の気持ちを尊重し会話が良くなる助言をする。
- 情報不足のときは無理に断定せず、mood を「様子見」などにし、suggestions は相手を知るための質問にする。
- 装着者(self)の発話は相手の感情推定には使わず、相手の反応との対比にだけ使う。`

function formatTurns(turns: TranscriptTurn[]): string {
  return turns.map(t => `${t.speaker}: ${t.text}`).join('\n') || '(まだ発話なし)'
}

function formatPrevious(prev: Analysis | null | undefined): string {
  if (!prev) return ''
  const p = { emotions: prev.emotions, face: prev.face, mood: prev.mood, score: prev.score, scores: prev.scores }
  const mem = prev.memory ? `\n\n## memory(これまでの要点)\n${prev.memory}` : ''
  return `\n\n## previous(前回の推定)\n${JSON.stringify(p)}${mem}`
}

/**
 * 初回(または巻き直し)用: 会話履歴 + previous + memory を全部渡す。
 * `turns` は呼び出し側で絞ったものを渡す(直近 N 件など)。
 */
export function buildUserPrompt(req: AnalyzeRequest, turns: TranscriptTurn[] = req.turns): string {
  const lang = req.lang ?? 'ja'
  return `lang: ${lang}\n\n## 会話(古い順、最新が最後)\n${formatTurns(turns)}${formatPrevious(req.previous)}\n\n最新の発話まで踏まえて、相手の状態と次の一言を JSON で出力してください。`
}

/** セッション継続用: 新しい発話だけを渡す */
export function buildDeltaPrompt(newTurns: TranscriptTurn[]): string {
  return `## 新しい発話\n${formatTurns(newTurns)}\n\nここまでの流れを踏まえて、相手の状態と次の一言を更新した JSON で出力してください(memory も更新)。`
}

/**
 * 文章モード: 数値判定(感情・顔・スコア)は Jev が 0.2 秒で出すので、LLM には文章だけを頼む。
 * 出力が短くなる分速く、Jev の判定(judgement)を前提に助言を書かせるので表示と矛盾しない。
 */
export const SYSTEM_PROMPT_TEXT = SYSTEM_PROMPT
  .replace(/## 出力\(JSON\)[\s\S]*?## 出力の仕方\(重要\)/, `## 出力(JSON)
- 相手の感情・表情・スコアは別の判定システムが既に出している(judgement として渡す)。あなたはそれを前提に文章だけを書く。数値は出力しない。
- digDeeper: 相手が触れたが掘り下げられていない話題、感情が動いた瞬間、気になる言い回しなど「今ここを深掘りすべき」点。最大 2 件、各 全角 20 文字以内。
- suggestions: 装着者が次に言うと良い具体的な一言。そのまま口に出せる自然な口語で、最大 2 件、各 全角 22 文字以内。1 件目は質問か共感、2 件目は別方向(話題転換など)。judgement の mood に合った言い方にする。
- summary: 会話の今の状況を全角 30 文字以内で 1 文。
- memory: これまでの会話の要点(話題、相手の事情、感情の推移、未回収の伏線)を全角 100 文字以内で更新して保持。次回はこれだけを頼りに古い発話を思い出すので、固有名詞と出来事を優先し、修飾語は削る。
- 出力は短いほど良い(表示は小さな画面、応答速度が最優先)。

## 出力の仕方(重要)`)
  .replace('ツールの引数には上記フィールド(emotions, face, mood, score, scores, digDeeper, suggestions, summary, memory)を', 'ツールの引数には上記フィールド(digDeeper, suggestions, summary, memory)を')

export const systemPromptFor = (mode: LlmMode) => (mode === 'text' ? SYSTEM_PROMPT_TEXT : SYSTEM_PROMPT)

function formatJudgement(prev: Analysis | null | undefined): string {
  if (!prev || !prev.score) return ''
  return `\n\n## judgement(判定システムの現在の推定)\n${JSON.stringify({ face: prev.face, mood: prev.mood, score: prev.score, emotions: prev.emotions, scores: prev.scores })}`
}

/** 文章モードの初回プロンプト: 会話履歴 + judgement + memory */
export function buildUserPromptText(req: AnalyzeRequest, turns: TranscriptTurn[] = req.turns): string {
  const lang = req.lang ?? 'ja'
  const mem = req.previous?.memory ? `\n\n## memory(これまでの要点)\n${req.previous.memory}` : ''
  return `lang: ${lang}\n\n## 会話(古い順、最新が最後)\n${formatTurns(turns)}${formatJudgement(req.previous)}${mem}\n\n最新の発話と judgement を踏まえて、次の一言・深掘り・要約・memory を JSON で出力してください。`
}

/** 文章モードのセッション継続用: 新しい発話 + 現在の judgement */
export function buildDeltaPromptText(newTurns: TranscriptTurn[], previous: Analysis | null | undefined): string {
  return `## 新しい発話\n${formatTurns(newTurns)}${formatJudgement(previous)}\n\nここまでの流れと judgement を踏まえて、次の一言・深掘り・要約・memory を更新した JSON で出力してください。`
}

export const userPromptFor = (mode: LlmMode, req: AnalyzeRequest, turns: TranscriptTurn[]) => (mode === 'text' ? buildUserPromptText(req, turns) : buildUserPrompt(req, turns))
export const deltaPromptFor = (mode: LlmMode, newTurns: TranscriptTurn[], previous: Analysis | null | undefined) => (mode === 'text' ? buildDeltaPromptText(newTurns, previous) : buildDeltaPrompt(newTurns))
