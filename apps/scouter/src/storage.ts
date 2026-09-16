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
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
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
