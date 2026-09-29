// 文字起こしプロバイダ。入力は PCM s16le / 16kHz / mono。Node / Workers 共通(Web API のみ使用)。
import type { Config } from './config'
import { mockTranscribe } from './mock'

export interface SttProvider {
  name: string
  transcribe(pcm: Uint8Array, lang: string): Promise<string>
}

const SAMPLE_RATE = 16000

export function wavWrap(pcm: Uint8Array): Uint8Array {
  const header = new ArrayBuffer(44)
  const v = new DataView(header)
  const write = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }
  write(0, 'RIFF'); v.setUint32(4, 36 + pcm.byteLength, true); write(8, 'WAVE')
  write(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  write(36, 'data'); v.setUint32(40, pcm.byteLength, true)
  const out = new Uint8Array(44 + pcm.byteLength)
  out.set(new Uint8Array(header), 0)
  out.set(pcm, 44)
  return out
}

export function rmsOf(pcm: Uint8Array): number {
  const n = Math.floor(pcm.byteLength / 2)
  if (!n) return 0
  const dv = new DataView(pcm.buffer, pcm.byteOffset, n * 2)
  let acc = 0
  for (let i = 0; i < n; i++) { const s = dv.getInt16(i * 2, true); acc += s * s }
  return Math.sqrt(acc / n)
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(bin)
}

const LANG_NAME: Record<string, string> = { ja: 'Japanese', en: 'English' }

/**
 * Whisper が無音・雑音に対して返しがちな定型句(YouTube 字幕由来の幻聴)。これだけの出力は捨てる。
 */
const HALLUCINATIONS = [
  /^ご視聴ありがとうございました[。.!！]?$/,
  /^ご清聴ありがとうございました[。.!！]?$/,
  /^チャンネル登録.*$/,
  /^字幕.*$/,
  /^おやすみなさい[。.!！]?$/,
  /^(ありがとうございました|ありがとうございます)[。.!！]?$/,
  /^\[.*\]$/,
  /^\(.*\)$/,
  /^♪+$/,
  // 以下は gate-eval(scripts/gate-eval.ts)で漏れていた型
  /ご視聴ありがとう/,                 // 文中に混ざる(「お疲れ様でした。ご視聴ありがとうございました」)
  /^次の動画.*$/,
  /^提供$/,
  /^[。、．・…\s]+$/,                  // 句読点だけ
  /^(.{1,3})\1{3,}$/,                 // 同じ 1〜3 文字の 4 回以上の繰り返し(はいはいはいはい / んんんんんん)。「はいはい、なるほど」は残る
]
export function dropHallucination(text: string): string {
  const t = text.trim()
  return HALLUCINATIONS.some(re => re.test(t)) ? '' : t
}

function openai(cfg: Config, name = 'openai'): SttProvider {
  return {
    name,
    async transcribe(pcm, lang) {
      const form = new FormData()
      form.append('file', new Blob([wavWrap(pcm).buffer as ArrayBuffer], { type: 'audio/wav' }), 'chunk.wav')
      form.append('model', cfg.openaiSttModel)
      form.append('language', lang)
      form.append('response_format', 'json')
      const res = await fetch(`${cfg.openaiSttBaseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: cfg.openaiKey ? { Authorization: `Bearer ${cfg.openaiKey}` } : {},
        body: form,
      })
      if (!res.ok) throw new Error(`${name} stt ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const json = (await res.json()) as { text?: string }
      return dropHallucination(json.text ?? '')
    },
  }
}

function gemini(cfg: Config): SttProvider {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.geminiSttModel}:generateContent?key=${cfg.geminiKey}`
  // 思考をオフにすると 2 秒の音声で 6.7 秒 → 3.3 秒(gemini-3.6-flash 実測)。
  // 古いモデルは thinkingLevel を受け付けない(400)ので、その場合は設定なしで再試行する。
  let thinkingSupported = true
  const call = async (pcm: Uint8Array, lang: string, withThinking: boolean) => {
    const body = {
      contents: [{
        parts: [
          { inline_data: { mime_type: 'audio/wav', data: toBase64(wavWrap(pcm)) } },
          { text: `Transcribe this audio verbatim in ${LANG_NAME[lang] ?? lang}. Output only the transcript text, no quotes, no commentary. If the audio is silence, noise, music, or tones with no intelligible speech, output nothing at all.` },
        ],
      }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 256,
        ...(withThinking ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
      },
    }
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  }
  return {
    name: 'gemini',
    async transcribe(pcm, lang) {
      let res = await call(pcm, lang, thinkingSupported)
      if (res.status === 400 && thinkingSupported) {
        thinkingSupported = false
        res = await call(pcm, lang, false)
      }
      if (!res.ok) throw new Error(`gemini stt ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
      return (json.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join('').trim()
    },
  }
}

const mock: SttProvider = {
  name: 'mock',
  async transcribe() {
    await new Promise(r => setTimeout(r, 300))
    return mockTranscribe()
  },
}

export function pickStt(cfg: Config): SttProvider {
  const want = cfg.sttProvider
  // whisper = ローカルの whisper-server(--inference-path /v1/audio/transcriptions で OpenAI 互換)
  if (want === 'whisper') return openai({ ...cfg, openaiKey: undefined, openaiSttBaseUrl: cfg.whisperUrl }, 'whisper')
  if (want === 'openai') return openai(cfg)
  if (want === 'gemini') return gemini(cfg)
  if (want === 'mock') return mock
  if (cfg.openaiKey || !cfg.openaiSttBaseUrl.startsWith('https://api.openai.com')) return openai(cfg)
  if (cfg.geminiKey) return gemini(cfg)
  return mock
}
