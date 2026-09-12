// API キーなしで一通り動かすためのモック。
import type { Analysis, AnalyzeRequest } from '../shared/types'

const MOCK_LINES = [
  '最近、仕事がちょっと忙しくて。',
  'でも週末に友達とキャンプに行ったんです。',
  '焚き火を見てるとなんか落ち着きますよね。',
  'ただ帰りの渋滞が本当にひどくて、疲れました。',
  '次はもう少し近場でいいかなって思ってます。',
  'あ、そういえば新しいカメラを買ったんですよ。',
  '写真を撮るのが楽しくて、休みが待ち遠しいです。',
]
let mockIdx = 0

export function mockTranscribe(): string {
  const line = MOCK_LINES[mockIdx % MOCK_LINES.length]
  mockIdx++
  return line
}

const POS = ['楽し', '嬉し', '好き', '面白', '落ち着', '待ち遠し', 'よかった', '最高', 'ありがと']
const NEG = ['疲れ', 'ひど', '嫌', '困', '忙し', 'つら', '最悪', 'ムカ', '腹立']
const ANGRY = ['ムカ', '腹立', '許せ', 'ふざけ', '最悪']
const SAD = ['悲し', '寂し', '泣', 'つら', '落ち込']

export function mockAnalyze(req: AnalyzeRequest): Analysis {
  const others = req.turns.filter(t => t.speaker !== 'self')
  const text = others.map(t => t.text).join(' ')
  const count = (words: string[]) => words.reduce((n, w) => n + (text.split(w).length - 1), 0)
  const pos = count(POS)
  const neg = count(NEG)
  const angry = count(ANGRY)
  const sad = count(SAD)
  const base = req.previous?.emotions ?? { joy: 30, anger: 10, sorrow: 15, pleasure: 30 }
  const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)))
  const emotions = {
    joy: clamp(base.joy * 0.5 + 25 + pos * 12 - neg * 6),
    anger: clamp(base.anger * 0.5 + 5 + angry * 25),
    sorrow: clamp(base.sorrow * 0.5 + 8 + sad * 20 + neg * 5),
    pleasure: clamp(base.pleasure * 0.5 + 25 + pos * 10 - neg * 4),
  }
  const top = Object.entries(emotions).sort((a, b) => b[1] - a[1])[0][0]
  const face: Analysis['face'] =
    emotions.anger > 55 ? 'angry' : emotions.sorrow > 55 ? 'sad' : top === 'joy' && emotions.joy > 60 ? 'happy' : top === 'pleasure' && emotions.pleasure > 55 ? 'relaxed' : neg > pos ? 'tired' : 'neutral'
  const lastOther = others.at(-1)?.text ?? ''
  const topic = lastOther.replace(/[。、！？!?]/g, '').slice(0, 10)
  const score = clamp((emotions.joy + emotions.pleasure) / 2 - emotions.anger / 3 - emotions.sorrow / 4 + Math.min(20, others.length * 3))
  return {
    emotions,
    face,
    mood: face === 'happy' ? '上機嫌' : face === 'angry' ? '苛立ち' : face === 'sad' ? '沈み気味' : face === 'relaxed' ? 'リラックス' : face === 'tired' ? 'お疲れ' : '様子見',
    score,
    scores: { engagement: clamp(40 + others.length * 5 + pos * 5), rapport: clamp(35 + others.length * 4), openness: clamp(30 + neg * 6 + pos * 4) },
    digDeeper: topic ? [`「${topic}」の背景をもう一歩`, '感情が動いた瞬間の理由'] : ['まず相手の近況を聞く'],
    suggestions: topic ? [`${topic}、どんな感じでした？`, 'それで、その後どうなったんですか？', 'それは大変でしたね'] : ['最近どうですか？'],
    summary: others.length ? `相手は${topic ? `「${topic}」について` : ''}話している(mock)` : '会話開始前(mock)',
  }
}
