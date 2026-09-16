// マイク PCM(s16le / 16kHz / mono)を話者ごとにバッファし、一定量たまったらプロキシへ POST する。
// WebSocket は iOS WKWebView で失敗報告があるため使わない。Blob body の fetch のみ。
import type { Speaker, TranscribeResponse } from '../shared/types'

const SAMPLE_RATE = 16000
const BYTES_PER_SEC = SAMPLE_RATE * 2
/** これだけ溜まったら送る(発話の切れ目があれば SILENCE_GAP_MS で先に送る)。
 *  ローカル whisper は 0.3 秒で返るので長めにして文の途中切れを減らす */
const CHUNK_MS = 4000
/** この長さ未満の音声は送らない(ノイズ節約) */
const MIN_MS = 600
/** 無音判定の RMS しきい値(int16) */
const SILENCE_RMS = 350
/** 発話の後、これだけ無音が続いたら区切って送る */
const SILENCE_GAP_MS = 700
/** 429 を受けたらこれだけ送信を止める */
const RATE_LIMIT_PAUSE_MS = 60_000

export interface AudioStats {
  frames: number
  bytes: number
  sent: number
  ok: number
  failed: number
  lastRms: number
  lastError: string
  inFlight: number
  /** レート制限で送信を止めている間の解除時刻(ms)。0 なら通常 */
  pausedUntil: number
}

export interface TranscriptResult {
  speaker: Speaker
  text: string
  ms: number
}

interface SpeakerBuffer {
  chunks: Uint8Array[]
  bytes: number
  voicedBytes: number
  silentTailMs: number
}

export class AudioPipeline {
  readonly stats: AudioStats = { frames: 0, bytes: 0, sent: 0, ok: 0, failed: 0, lastRms: 0, lastError: '', inFlight: 0, pausedUntil: 0 }
  private buffers = new Map<Speaker, SpeakerBuffer>()
  private queue: Promise<void> = Promise.resolve()
  private active = false

  constructor(
    private opts: {
      proxyUrl: () => string
      proxyToken: () => string
      lang: () => string
      /** チャンク長(ms)。未指定なら CHUNK_MS */
      chunkMs?: () => number
      onTranscript: (r: TranscriptResult) => void
      onError: (msg: string) => void
      onActivity?: () => void
    },
  ) {}

  start() {
    this.active = true
  }

  /** 末尾のバッファを強制送信して停止 */
  async stop() {
    this.active = false
    for (const sp of [...this.buffers.keys()]) this.flush(sp, true)
    await this.queue
  }

  /** onEvenHubEvent の audioEvent から呼ぶ */
  push(pcm: Uint8Array, speaker: Speaker) {
    if (!this.active) return
    this.stats.frames++
    this.stats.bytes += pcm.byteLength
    const rms = rmsOf(pcm)
    this.stats.lastRms = rms
    const frameMs = (pcm.byteLength / BYTES_PER_SEC) * 1000
    const voiced = rms >= SILENCE_RMS
    if (voiced) this.opts.onActivity?.()

    let buf = this.buffers.get(speaker)
    if (!buf) {
      buf = { chunks: [], bytes: 0, voicedBytes: 0, silentTailMs: 0 }
      this.buffers.set(speaker, buf)
    }
    // 発話が全く無いバッファに無音を溜め続けない
    if (!voiced && buf.voicedBytes === 0) {
      // 直前 300ms 程度だけ残す(語頭が欠けないように)
      if (buf.bytes > BYTES_PER_SEC * 0.3) {
        buf.chunks = []
        buf.bytes = 0
      }
      buf.chunks.push(pcm)
      buf.bytes += pcm.byteLength
      return
    }
    buf.chunks.push(pcm)
    buf.bytes += pcm.byteLength
    if (voiced) {
      buf.voicedBytes += pcm.byteLength
      buf.silentTailMs = 0
    } else {
      buf.silentTailMs += frameMs
    }

    const bufMs = (buf.bytes / BYTES_PER_SEC) * 1000
    const voicedMs = (buf.voicedBytes / BYTES_PER_SEC) * 1000
    const chunkMs = Math.max(1000, this.opts.chunkMs?.() ?? CHUNK_MS)
    if (bufMs >= chunkMs || (voicedMs >= MIN_MS && buf.silentTailMs >= SILENCE_GAP_MS)) {
      this.flush(speaker, false)
    }
  }

  private flush(speaker: Speaker, force: boolean) {
    const buf = this.buffers.get(speaker)
    if (!buf || buf.bytes === 0) return
    const voicedMs = (buf.voicedBytes / BYTES_PER_SEC) * 1000
    const pcm = concat(buf.chunks, buf.bytes)
    this.buffers.set(speaker, { chunks: [], bytes: 0, voicedBytes: 0, silentTailMs: 0 })
    if (voicedMs < (force ? 300 : MIN_MS)) return

    const url = this.opts.proxyUrl()
    if (!url) return
    // レート制限中は送らずに捨てる(溜めても上限が増えるわけではない)
    if (this.stats.pausedUntil > Date.now()) return
    this.queue = this.queue.then(() => this.send(url, pcm, speaker)).catch(() => undefined)
  }

  private async send(base: string, pcm: Uint8Array, speaker: Speaker) {
    const t0 = Date.now()
    this.stats.sent++
    this.stats.inFlight++
    try {
      const u = new URL('/transcribe', base)
      u.searchParams.set('speaker', speaker)
      u.searchParams.set('lang', this.opts.lang())
      const res = await fetch(u.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...authHeader(this.opts.proxyToken()) },
        body: new Blob([pcm.buffer as ArrayBuffer], { type: 'application/octet-stream' }),
      })
      const json = (await res.json()) as TranscribeResponse
      if (res.status === 429) {
        this.stats.pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS
        throw new Error(`STT レート制限。${RATE_LIMIT_PAUSE_MS / 1000} 秒送信を止めます: ${json.ok ? '' : json.error.slice(0, 120)}`)
      }
      if (!res.ok || !json.ok) {
        const err = json.ok ? `HTTP ${res.status}` : json.error
        throw new Error(err)
      }
      this.stats.ok++
      const text = json.text.trim()
      if (text) this.opts.onTranscript({ speaker, text, ms: Date.now() - t0 })
    } catch (e) {
      this.stats.failed++
      this.stats.lastError = (e as Error).message
      this.opts.onError(`transcribe: ${(e as Error).message}`)
    } finally {
      this.stats.inFlight--
    }
  }
}

export function authHeader(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function rmsOf(pcm: Uint8Array): number {
  const n = Math.floor(pcm.byteLength / 2)
  if (n === 0) return 0
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2)
  let acc = 0
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true)
    acc += s * s
  }
  return Math.sqrt(acc / n)
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}
