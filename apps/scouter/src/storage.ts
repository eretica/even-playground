// 設定の永続化。bridge.setLocalStorage が唯一信頼できる保存先(ブラウザ localStorage は .ehpk で消える)。
// ブリッジが無い(素のブラウザ)ときはメモリ + window.localStorage にフォールバックする。
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

export interface Settings {
  proxyUrl: string
  /** サーバの SHARED_SECRET と同じ値(Authorization: Bearer で送る) */
  proxyToken: string
  lang: string
  /** speakerRole が unknown のフレームをどの話者として扱うか */
  unknownAs: 'unknown' | 'other' | 'self'
  /** 何もしゃべらない状態が続いたら自動でマイクを止める(分、0 で無効) */
  idleMinutes: number
  debugOverlay: boolean
  /** 解析の最短間隔(秒)。大きいほどサブスク枠を節約 */
  analyzeIntervalSec: number
  /** 音声をまとめて送る長さ(秒)。長いほど文の途中切れが減り、反応は遅くなる */
  chunkSec: number
}

export const DEFAULT_SETTINGS: Settings = {
  proxyUrl: '',
  proxyToken: '',
  lang: 'ja',
  unknownAs: 'unknown',
  idleMinutes: 10,
  debugOverlay: false,
  analyzeIntervalSec: 4,
  chunkSec: 4,
}

const KEY = 'scouter.settings.v1'

/** サーバ URL を正規化する。スキーム無しは http を補い、末尾の / を落とす。不正なら '' */
export function normalizeProxyUrl(raw: string): string {
  let v = raw.trim()
  if (!v) return ''
  if (!/^[a-z]+:\/\//i.test(v)) v = `http://${v}`
  v = v.replace(/\/+$/, '')
  try {
    const u = new URL(v)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return v
  } catch {
    return ''
  }
}

/** ベース URL とパスを結合(`new URL(path, base)` は base の /api を捨ててしまうので使わない) */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/** HTTP ヘッダーに入れられる文字だけ残す(全角や改行が混ざると fetch が例外を投げる) */
export function sanitizeToken(raw: string): string {
  return raw.replace(/[^\x21-\x7e]/g, '')
}

let bridgeRef: EvenAppBridge | null = null
export function bindStorage(bridge: EvenAppBridge | null) {
  bridgeRef = bridge
}

export async function loadSettings(): Promise<Settings> {
  let raw = ''
  try {
    raw = bridgeRef ? await bridgeRef.getLocalStorage(KEY) : (window.localStorage.getItem(KEY) ?? '')
  } catch {
    raw = ''
  }
  if (!raw) return { ...DEFAULT_SETTINGS }
  try {
    const s = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
    s.proxyUrl = normalizeProxyUrl(s.proxyUrl)
    s.proxyToken = sanitizeToken(s.proxyToken ?? '')
    return s
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  const raw = JSON.stringify(s)
  try {
    if (bridgeRef) await bridgeRef.setLocalStorage(KEY, raw)
    else window.localStorage.setItem(KEY, raw)
  } catch (e) {
    console.warn('saveSettings failed', e)
  }
}
