// G2 描画レイヤ。ブリッジ呼び出しは全部 enqueue で直列化し、差分のあるコンテナだけ更新する。
//
// レイアウト(576x288):
//   ┌────────┬──────────────────────────────┐
//   │ face   │ gauges(喜怒哀楽 4 行)          │  y 0..124
//   │ 120x120│                              │
//   ├────────┴──────────────────────────────┤
//   │ panel(5 行、入力キャプチャ)            │  y 126..288
//   └───────────────────────────────────────┘
import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  ImageContainerProperty,
  TextContainerUpgrade,
  ImageRawDataUpdate,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  EventSourceType,
  AudioInputSource,
  AudioSpeakerRole,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import type { FaceKind, Speaker } from '../shared/types'
import { FACE_SIZE, facePng, faceText } from './face'

export const SCREEN_W = 576
export const SCREEN_H = 288

const FACE_ID = 1
const FACE_NAME = 'face'
const GAUGE_ID = 2
const GAUGE_NAME = 'gauges'
const PANEL_ID = 3
const PANEL_NAME = 'panel'
const FACE_TXT_ID = 4
const FACE_TXT_NAME = 'facetxt'

export const GAUGE_BOX = { x: 136, y: 0, w: 440, h: 124, pad: 4 }
export const PANEL_BOX = { x: 0, y: 126, w: 576, h: 162, pad: 4 }
export const GAUGE_INNER_W = GAUGE_BOX.w - GAUGE_BOX.pad * 2
export const PANEL_INNER_W = PANEL_BOX.w - PANEL_BOX.pad * 2
export const PANEL_MAX_LINES = 5

export const MENU = {
  MIC: 1,
  RESET: 2,
  NEXT: 3,
  EXIT: 4,
} as const

const BRIDGE_TIMEOUT_MS = 6000
const EVENT_DEDUPE_MS = 600

export type InputSource = 'glasses' | 'ring' | 'unknown'

export interface GlassesView {
  gauges: string
  panel: string
  face: FaceKind
}

export interface GlassesHandlers {
  onTap: (src: InputSource) => void
  onDoubleTap: (src: InputSource) => void
  onSwipe: (dir: 'up' | 'down') => void
  onMenu: (itemID: number) => void
  onForeground: () => void
  onExit: () => void
  onAudio: (pcm: Uint8Array, speaker: Speaker) => void
  onLog: (msg: string) => void
}

export interface Glasses {
  render: (view: GlassesView, opts?: { micOn: boolean }) => Promise<void>
  startMic: () => Promise<boolean>
  stopMic: () => Promise<void>
  requestExit: () => Promise<void>
  bridge: EvenAppBridge
  imageMode: () => 'image' | 'text'
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(`${label}: timeout ${ms}ms`)), ms)
    p.then(
      v => { window.clearTimeout(t); resolve(v) },
      e => { window.clearTimeout(t); reject(e) },
    )
  })
}

function menuObject(micOn: boolean): MenuContainerProperty {
  return new MenuContainerProperty({
    menuItems: [
      new MenuItemProperty({ itemName: micOn ? 'Mic OFF' : 'Mic ON', itemID: MENU.MIC }),
      new MenuItemProperty({ itemName: 'Next panel', itemID: MENU.NEXT }),
      new MenuItemProperty({ itemName: 'Reset', itemID: MENU.RESET }),
      new MenuItemProperty({ itemName: 'Exit', itemID: MENU.EXIT }),
    ],
  })
}

export async function connectGlasses(initial: GlassesView, h: GlassesHandlers): Promise<Glasses | null> {
  let bridge: EvenAppBridge
  try {
    bridge = await withTimeout(waitForEvenAppBridge(), 4000, 'waitForEvenAppBridge')
  } catch {
    return null
  }

  let imageMode: 'image' | 'text' = 'image'
  let last: GlassesView = { ...initial }
  let lastMenuMic = false
  let faceSent: FaceKind | null = null
  let startupCalled = false
  let exitPending = false
  let micOn = false

  // ---- 直列キュー ----
  let busy: Promise<unknown> = Promise.resolve()
  function enqueue<T>(label: string, work: () => Promise<T>): Promise<T> {
    const run = () => withTimeout(work(), BRIDGE_TIMEOUT_MS, label)
    const next = busy.then(run, run)
    busy = next.then(() => undefined, () => undefined)
    return next
  }

  function buildTextContainers(view: GlassesView, micFlag: boolean) {
    const gauges = new TextContainerProperty({
      xPosition: GAUGE_BOX.x, yPosition: GAUGE_BOX.y, width: GAUGE_BOX.w, height: GAUGE_BOX.h,
      borderWidth: 0, borderColor: 0, paddingLength: GAUGE_BOX.pad,
      containerID: GAUGE_ID, containerName: GAUGE_NAME,
      content: view.gauges || ' ',
      isEventCapture: 0,
    })
    const panel = new TextContainerProperty({
      xPosition: PANEL_BOX.x, yPosition: PANEL_BOX.y, width: PANEL_BOX.w, height: PANEL_BOX.h,
      borderWidth: 0, borderColor: 0, paddingLength: PANEL_BOX.pad,
      containerID: PANEL_ID, containerName: PANEL_NAME,
      content: view.panel || ' ',
      isEventCapture: 1,
    })
    const textObject = [gauges, panel]
    const imageObject: ImageContainerProperty[] = []
    if (imageMode === 'image') {
      imageObject.push(new ImageContainerProperty({
        xPosition: 8, yPosition: 2, width: FACE_SIZE, height: FACE_SIZE,
        containerID: FACE_ID, containerName: FACE_NAME,
      }))
    } else {
      textObject.push(new TextContainerProperty({
        xPosition: 8, yPosition: 4, width: 124, height: 118,
        borderWidth: 0, borderColor: 0, paddingLength: 2,
        containerID: FACE_TXT_ID, containerName: FACE_TXT_NAME,
        content: faceText(view.face),
        isEventCapture: 0,
      }))
    }
    return { textObject, imageObject, containerTotalNum: textObject.length + imageObject.length, menuObject: menuObject(micFlag) }
  }

  async function sendFace(kind: FaceKind): Promise<void> {
    if (imageMode !== 'image') return
    const r = await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: FACE_ID, containerName: FACE_NAME, imageData: facePng(kind) }))
    if (r !== 'success') {
      h.onLog(`face image failed: ${r} → text face にフォールバック`)
      imageMode = 'text'
      await rebuild(last, micOn)
      return
    }
    faceSent = kind
  }

  async function rebuild(view: GlassesView, micFlag: boolean): Promise<boolean> {
    const page = buildTextContainers(view, micFlag)
    const ok = await bridge.rebuildPageContainer(new RebuildPageContainer(page))
    h.onLog(`rebuild → ${ok}`)
    last = { ...view }
    lastMenuMic = micFlag
    faceSent = null
    if (ok && imageMode === 'image') await sendFace(view.face)
    return ok
  }

  // ---- 起動ページ(1 回だけ)----
  const startupOk = await enqueue('startup', async () => {
    startupCalled = true
    const page = buildTextContainers(initial, false)
    const r = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page))
    h.onLog(`createStartUpPageContainer → ${r}`)
    return r === 0
  })
  if (!startupOk) {
    // 再試行は ~2 秒ブロックして invalid で返るので rebuild に流す
    await enqueue('rebuild-fallback', () => rebuild(initial, false))
  }
  await enqueue('face-initial', () => sendFace(initial.face))

  // ---- イベント ----
  const recent = new Map<number, number>()
  function dedupe(type: number): boolean {
    const now = Date.now()
    const prev = recent.get(type) ?? 0
    recent.set(type, now)
    return now - prev < EVENT_DEDUPE_MS
  }
  const typeOf = (env?: { eventType?: number }): number | null => {
    if (!env) return null
    return env.eventType ?? OsEventTypeList.CLICK_EVENT
  }
  const srcOf = (src?: number): InputSource => {
    if (src === EventSourceType.TOUCH_EVENT_FROM_RING) return 'ring'
    if (src === EventSourceType.TOUCH_EVENT_FROM_GLASSES_L || src === EventSourceType.TOUCH_EVENT_FROM_GLASSES_R) return 'glasses'
    return 'unknown'
  }

  // Vite の HMR でモジュールが再評価されると古い onEvenHubEvent 登録が残り、タップが多重に処理される。
  // 前回の登録をグローバル経由で確実に解除する(本番はフルリロードなので無害)。
  const w = window as unknown as { __scouterDispose?: () => void }
  w.__scouterDispose?.()

  const unsubscribe = bridge.onEvenHubEvent((ev: EvenHubEvent) => {
    const audio = ev.audioEvent
    if (audio?.audioPcm) {
      const role = audio.speakerRole
      const speaker: Speaker = role === AudioSpeakerRole.Self ? 'self' : role === AudioSpeakerRole.Other ? 'other' : 'unknown'
      h.onAudio(audio.audioPcm, speaker)
      return
    }
    const menuID = ev.menuItemClickEvent?.itemID
    if (menuID !== undefined && menuID !== 0) {
      h.onMenu(menuID)
      return
    }

    console.debug('[scouter:ev]', JSON.stringify(ev))
    const sysType = typeOf(ev.sysEvent)
    const textType = typeOf(ev.textEvent)
    const src = srcOf(ev.sysEvent?.eventSource)

    // スクロールは textEvent のみ
    if (textType === OsEventTypeList.SCROLL_TOP_EVENT || textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      if (dedupe(100 + textType)) return
      h.onSwipe(textType === OsEventTypeList.SCROLL_TOP_EVENT ? 'up' : 'down')
      return
    }

    const t = sysType ?? textType
    if (t === null) return

    switch (t) {
      case OsEventTypeList.DOUBLE_CLICK_EVENT:
        if (dedupe(t)) return
        h.onDoubleTap(src)
        return
      case OsEventTypeList.CLICK_EVENT:
        if (dedupe(t)) return
        h.onTap(src)
        return
      case OsEventTypeList.FOREGROUND_ENTER_EVENT:
        if (dedupe(t)) return
        if (exitPending) {
          // 終了ダイアログが出た合図(ページはホスト側で消えている)。答えが返るまで待つ。
          h.onLog('exit dialog shown')
          return
        }
        h.onForeground()
        void enqueue('fg-rebuild', () => rebuild(last, micOn))
        return
      case OsEventTypeList.FOREGROUND_EXIT_EVENT:
        if (dedupe(t)) return
        if (exitPending) {
          // ユーザーが「いいえ」→ ページを戻す
          exitPending = false
          h.onLog('exit cancelled → rebuild')
          void enqueue('cancel-rebuild', () => rebuild(last, micOn))
        }
        return
      case OsEventTypeList.SYSTEM_EXIT_EVENT:
      case OsEventTypeList.ABNORMAL_EXIT_EVENT:
        exitPending = false
        startupCalled = false
        h.onLog(`exit event ${t}`)
        cleanup()
        h.onExit()
        return
      default:
        return
    }
  })

  let cleaned = false
  function cleanup() {
    if (cleaned) return
    cleaned = true
    void bridge.audioControl(false)
    unsubscribe()
  }
  window.addEventListener('beforeunload', cleanup)
  w.__scouterDispose = () => {
    unsubscribe()
    void bridge.audioControl(false)
  }
  void startupCalled

  // ---- 公開 API ----
  const g: Glasses = {
    bridge,
    imageMode: () => imageMode,
    async render(view, opts) {
      const mic = opts?.micOn ?? micOn
      await enqueue('render', async () => {
        // メニューのラベル(Mic ON/OFF)が変わる時、または image→text 切替直後は rebuild
        if (mic !== lastMenuMic) {
          await rebuild(view, mic)
          return
        }
        if (view.gauges !== last.gauges) {
          const ok = await bridge.textContainerUpgrade(new TextContainerUpgrade({
            containerID: GAUGE_ID, containerName: GAUGE_NAME, content: view.gauges || ' ',
          }))
          if (!ok) h.onLog('gauges upgrade failed')
          last.gauges = view.gauges
        }
        if (view.panel !== last.panel) {
          const ok = await bridge.textContainerUpgrade(new TextContainerUpgrade({
            containerID: PANEL_ID, containerName: PANEL_NAME, content: view.panel || ' ',
          }))
          if (!ok) h.onLog('panel upgrade failed')
          last.panel = view.panel
        }
        if (view.face !== last.face || (imageMode === 'image' && faceSent !== view.face)) {
          last.face = view.face
          if (imageMode === 'image') await sendFace(view.face)
          else {
            await bridge.textContainerUpgrade(new TextContainerUpgrade({
              containerID: FACE_TXT_ID, containerName: FACE_TXT_NAME, content: faceText(view.face),
            }))
          }
        }
      })
    },
    async startMic() {
      return enqueue('mic-on', async () => {
        const ok = await bridge.audioControl(true, AudioInputSource.Glasses)
        micOn = ok
        h.onLog(`audioControl(true) → ${ok}(許可の有無は PCM 到着で判定)`)
        return ok
      })
    },
    async stopMic() {
      await enqueue('mic-off', async () => {
        await bridge.audioControl(false)
        micOn = false
      })
    },
    async requestExit() {
      exitPending = true
      await enqueue('exit', () => bridge.shutDownPageContainer(1))
    },
  }
  return g
}
