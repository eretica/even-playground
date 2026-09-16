// Scouter — 会話相手の状態をスカウター風に表示する Even G2 アプリ。
//
// 流れ: G2 マイク PCM → AudioPipeline(話者別バッファ)→ POST /transcribe → turns[]
//       → POST /analyze(デバウンス)→ Analysis → グラス(ゲージ / 顔 / パネル)+ スマホ UI
import type { Analysis, AnalyzeRequest, AnalyzeResponse, FaceKind, HealthResponse, Speaker, TranscriptTurn } from '../shared/types'
import { EMPTY_ANALYSIS } from '../shared/types'
import { AudioPipeline, authHeader } from './audio'
import { connectGlasses, MENU, PANEL_INNER_W, PANEL_MAX_LINES, type Glasses, type GlassesView } from './glasses'
import { FACE_LABEL } from './face'
import { bindStorage, loadSettings, saveSettings, type Settings } from './storage'
import { bipolarGauge, clampLines, fitLine, fmtDuration, gauge, signed, wrapPx } from './text'
import * as ui from './ui'

// ---------------- 状態 ----------------
type Panel = 'main' | 'suggest' | 'dig' | 'score' | 'talk'
const PANELS: Panel[] = ['main', 'suggest', 'dig', 'score', 'talk']

const state = {
  settings: { ...(await loadSettings()) } as Settings,
  turns: [] as TranscriptTurn[],
  analysis: { ...EMPTY_ANALYSIS } as Analysis,
  /** 表示用に平滑化した感情 */
  smooth: { joy: 0, anger: 0, sorrow: 0, pleasure: 0 },
  panel: 'main' as Panel,
  micOn: false,
  micStartedAt: 0,
  lastVoiceAt: 0,
  proxyMode: 'unknown' as 'unknown' | 'live' | 'mock' | 'error',
  proxyLabel: '',
  analyzing: false,
  analyzedUpTo: 0,
  lastAnalyzeAt: 0,
  analyzeTimer: 0 as number,
  lastError: '',
  nextId: 1,
  /** サーバ側の会話セッション識別子(起動・リセットごとに更新) */
  sessionKey: newSessionKey(),
}

function newSessionKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

let glasses: Glasses | null = null

// ---------------- 起動 ----------------
ui.mountUi(
  {
    onToggleMic: () => void toggleMic(),
    onReset: () => resetSession(),
    onSaveSettings: s => void applySettings(s),
    onTestProxy: () => void checkProxy(true),
    onManualTurn: (speaker, text) => addTurn(speaker, text),
    onNextPanel: () => nextPanel(),
  },
  state.settings,
)

// プロキシ URL の既定値:
//   開発(Vite 配信)中は同一オリジンの /api(Vite が :8787 へ中継。whitelist / CORS 不要)
//   パッケージ版(.ehpk)は配信ホストが Even Hub になるので、設定画面で PC の URL を入れる
if (!state.settings.proxyUrl) {
  const envUrl = import.meta.env.VITE_PROXY_URL as string | undefined
  state.settings.proxyUrl = envUrl || (import.meta.env.DEV ? `${location.origin}/api` : `${location.protocol}//${location.hostname}:8787`)
}

const audio = new AudioPipeline({
  proxyUrl: () => state.settings.proxyUrl,
  proxyToken: () => state.settings.proxyToken,
  lang: () => state.settings.lang,
  chunkMs: () => state.settings.chunkSec * 1000,
  onTranscript: r => addTurn(r.speaker, r.text, r.ms),
  onError: msg => {
    state.lastError = msg
    ui.log(msg)
    ui.setStatus('error', msg)
  },
  onActivity: () => { state.lastVoiceAt = Date.now() },
})

ui.setAnalysis(state.analysis)
ui.setTranscript(state.turns)
ui.log(`proxy: ${state.settings.proxyUrl}`)

glasses = await connectGlasses(buildView(), {
  onTap: () => {
    if (!state.micOn) void toggleMic()
    else nextPanel()
  },
  onDoubleTap: () => void requestExit(),
  onSwipe: dir => (dir === 'down' ? nextPanel() : prevPanel()),
  onMenu: id => {
    if (id === MENU.MIC) void toggleMic()
    else if (id === MENU.NEXT) nextPanel()
    else if (id === MENU.RESET) resetSession()
    else if (id === MENU.EXIT) void requestExit()
  },
  onForeground: () => {
    ui.log('foreground enter')
    if (state.micOn) void glasses?.startMic() // Android で停止していた場合の再開
  },
  onExit: () => {
    void audio.stop()
    state.micOn = false
    ui.setStatus('idle', '終了しました')
  },
  onAudio: (pcm, speaker) => {
    const sp: Speaker = speaker === 'unknown' && state.settings.unknownAs !== 'unknown' ? state.settings.unknownAs : speaker
    audio.push(pcm, sp)
  },
  onLog: ui.log,
})

bindStorage(glasses?.bridge ?? null)
if (glasses) {
  ui.setStatus('idle', 'グラス接続済み。タップまたはボタンでマイク開始')
  ui.log(`glasses connected (face: ${glasses.imageMode()})`)
} else {
  ui.setStatus('noglasses', 'グラス未接続。テキスト入力で解析を試せます')
  ui.log('bridge not found (browser mode)')
}
void checkProxy(false)
window.setInterval(tick, 1000)

// ---------------- 操作 ----------------
async function toggleMic() {
  if (!glasses) {
    ui.setStatus('noglasses', 'グラス未接続のためマイクは使えません')
    return
  }
  if (state.micOn) {
    state.micOn = false
    await glasses.stopMic()
    await audio.stop()
    ui.setStatus('paused', '一時停止中')
    ui.log('mic off')
  } else {
    audio.start()
    const ok = await glasses.startMic()
    state.micOn = ok
    state.micStartedAt = Date.now()
    state.lastVoiceAt = Date.now()
    ui.setStatus(ok ? 'listening' : 'error', ok ? '聞き取り中…' : 'マイク開始に失敗')
    ui.log(`mic on → ${ok}`)
  }
  void render()
}

function nextPanel() {
  state.panel = PANELS[(PANELS.indexOf(state.panel) + 1) % PANELS.length]
  void render()
}
function prevPanel() {
  state.panel = PANELS[(PANELS.indexOf(state.panel) - 1 + PANELS.length) % PANELS.length]
  void render()
}

function resetSession() {
  state.turns = []
  state.analysis = { ...EMPTY_ANALYSIS }
  state.smooth = { joy: 0, anger: 0, sorrow: 0, pleasure: 0 }
  state.analyzedUpTo = 0
  state.lastError = ''
  state.sessionKey = newSessionKey()
  ui.setAnalysis(state.analysis)
  ui.setTranscript(state.turns)
  ui.log('session reset')
  void render()
}

async function requestExit() {
  if (!glasses) return
  ui.log('exit requested')
  await glasses.requestExit()
}

async function applySettings(s: Settings) {
  state.settings = s
  await saveSettings(s)
  ui.log('settings saved')
  void checkProxy(true)
}

// ---------------- トランスクリプト / 解析 ----------------
function addTurn(speaker: Speaker, text: string, ms?: number) {
  const turn: TranscriptTurn = { id: state.nextId++, speaker, text, ts: Date.now() }
  state.turns.push(turn)
  if (state.turns.length > 200) state.turns.shift()
  ui.setTranscript(state.turns)
  ui.log(`[${speaker}] ${text}${ms ? ` (${ms}ms)` : ''}`)
  scheduleAnalyze()
  void render()
}

const ANALYZE_DEBOUNCE_MS = 1500
const CONTEXT_TURNS = 30

function scheduleAnalyze() {
  window.clearTimeout(state.analyzeTimer)
  const since = Date.now() - state.lastAnalyzeAt
  const minInterval = Math.max(2, state.settings.analyzeIntervalSec) * 1000
  const delay = Math.max(ANALYZE_DEBOUNCE_MS, minInterval - since)
  state.analyzeTimer = window.setTimeout(() => void analyze(), delay)
}

async function analyze() {
  if (state.analyzing) { scheduleAnalyze(); return }
  const lastId = state.turns.at(-1)?.id ?? 0
  if (lastId <= state.analyzedUpTo) return
  const base = state.settings.proxyUrl
  if (!base) return
  state.analyzing = true
  state.lastAnalyzeAt = Date.now()
  const t0 = Date.now()
  try {
    const body: AnalyzeRequest = {
      turns: state.turns.slice(-CONTEXT_TURNS),
      previous: state.analysis.score ? state.analysis : null,
      lang: state.settings.lang,
      sessionKey: state.sessionKey,
    }
    const res = await fetch(new URL('/analyze', base).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(state.settings.proxyToken) },
      body: JSON.stringify(body),
    })
    const json = (await res.json()) as AnalyzeResponse
    if (!res.ok || !json.ok) throw new Error(json.ok ? `HTTP ${res.status}` : json.error)
    state.analyzedUpTo = lastId
    applyAnalysis(json.analysis)
    state.lastError = ''
    ui.log(`analyze ok via ${json.provider} (${Date.now() - t0}ms) face=${json.analysis.face} score=${json.analysis.score}`)
    if (state.micOn) ui.setStatus('listening', '聞き取り中…')
  } catch (e) {
    state.lastError = `analyze: ${(e as Error).message}`
    ui.log(state.lastError)
    ui.setStatus('error', state.lastError)
  } finally {
    state.analyzing = false
    void render()
  }
}

function applyAnalysis(a: Analysis) {
  const alpha = state.analysis.score ? 0.6 : 1
  const mix = (prev: number, next: number) => prev + (next - prev) * alpha
  state.smooth = {
    joy: mix(state.smooth.joy, a.emotions.joy),
    anger: mix(state.smooth.anger, a.emotions.anger),
    sorrow: mix(state.smooth.sorrow, a.emotions.sorrow),
    pleasure: mix(state.smooth.pleasure, a.emotions.pleasure),
  }
  state.analysis = a
  ui.setAnalysis({ ...a, emotions: state.smooth })
}

// ---------------- プロキシ ----------------
async function checkProxy(verbose: boolean) {
  const base = state.settings.proxyUrl
  if (!base) { state.proxyMode = 'error'; state.proxyLabel = 'URL未設定'; return }
  try {
    const res = await fetch(new URL('/health', base).toString(), { method: 'GET' })
    const json = (await res.json()) as HealthResponse
    const mock = json.stt === 'mock' || json.llm === 'mock'
    state.proxyMode = mock ? 'mock' : 'live'
    state.proxyLabel = `${json.stt}/${json.llm}`
    ui.log(`proxy ok: stt=${json.stt} llm=${json.llm} v${json.version} auth=${json.auth ? 'on' : 'off'}`)
    if (json.auth && !state.settings.proxyToken) {
      state.lastError = 'サーバトークン未設定'
      ui.setStatus('error', 'サーバはトークン認証を要求しています。設定にサーバトークンを入れてください')
      return
    }
    if (verbose) ui.setStatus(state.micOn ? 'listening' : 'idle', `サーバ OK (${state.proxyLabel})`)
  } catch (e) {
    state.proxyMode = 'error'
    state.proxyLabel = (e as Error).message
    ui.log(`proxy unreachable: ${base} — ${(e as Error).message}`)
    if (verbose) ui.setStatus('error', `サーバに接続できません: ${base}`)
  }
  void render()
}

// ---------------- 描画 ----------------
function tick() {
  // 無音が続いたら自動停止
  const idleMin = state.settings.idleMinutes
  if (state.micOn && idleMin > 0 && Date.now() - state.lastVoiceAt > idleMin * 60_000) {
    ui.log(`idle ${idleMin}min → mic off`)
    void toggleMic()
    return
  }
  if (state.micOn && state.panel === 'main') void render()
}

function buildView(): GlassesView {
  const ax = axes()
  const sc = state.analysis.scores
  // 上 2 行は 0 を中央にした双極(哀⇄喜、怒⇄楽)、下 2 行は 0-100 の単極
  const gauges = [
    `哀 ${bipolarGauge(ax.valence)} 喜 ${signed(ax.valence)}`,
    `怒 ${bipolarGauge(ax.ease)} 楽 ${signed(ax.ease)}`,
    `関心 ${gauge(sc.engagement)} ${Math.round(sc.engagement)}`,
    `本音 ${gauge(sc.openness)} ${Math.round(sc.openness)}`,
  ].join('\n')

  const lines = panelLines()
  return { gauges, panel: clampLines(lines, PANEL_MAX_LINES).join('\n'), face: state.analysis.face as FaceKind }
}

/** 喜怒哀楽(各 0-100)を 2 本の双極軸(-100..100)に落とす: valence = 喜 - 哀、ease = 楽 - 怒 */
export function toAxes(e: { joy: number; anger: number; sorrow: number; pleasure: number }) {
  return { valence: e.joy - e.sorrow, ease: e.pleasure - e.anger }
}
function axes() {
  return toAxes(state.smooth)
}

function header(): string {
  const a = state.analysis
  const rec = state.micOn ? `● ${fmtDuration(Date.now() - state.micStartedAt)}` : '○ 停止'
  const mode = state.proxyMode === 'live' ? 'LIVE' : state.proxyMode === 'mock' ? 'MOCK' : state.proxyMode === 'error' ? 'ERR' : '…'
  const score = a.score ? `総合 ${Math.round(a.score)}` : '総合 --'
  const mood = a.mood ? `${FACE_LABEL[a.face]}·${a.mood}` : ''
  return fitLine(`${rec} │ ${score} │ ${mood} │ ${mode}`, PANEL_INNER_W)
}

function panelLines(): string[] {
  const a = state.analysis
  const W = PANEL_INNER_W
  const out: string[] = [header()]
  const bullet = (prefix: string, text: string) => wrapPx(prefix + text, W)

  switch (state.panel) {
    case 'main': {
      if (state.lastError) out.push(fitLine(`! ${state.lastError}`, W))
      if (a.suggestions[0]) out.push(...bullet('▶ ', a.suggestions[0]))
      if (a.digDeeper[0]) out.push(...bullet('◆ 深掘り: ', a.digDeeper[0]))
      if (out.length === 1) out.push(state.micOn ? '会話を聞き取っています…' : 'タップでマイク開始')
      break
    }
    case 'suggest':
      out.push('[提案]')
      for (const s of a.suggestions.slice(0, 3)) out.push(...bullet('▶ ', s))
      if (!a.suggestions.length) out.push('（まだありません）')
      break
    case 'dig':
      out.push('[深掘りポイント]')
      for (const s of a.digDeeper.slice(0, 3)) out.push(...bullet('◆ ', s))
      if (a.summary) out.push(...bullet('≡ ', a.summary))
      break
    case 'score':
      out.push('[スコア]')
      out.push(`総合 ${gauge(a.score)} ${Math.round(a.score)}`)
      out.push(`関心 ${gauge(a.scores.engagement)} ${Math.round(a.scores.engagement)}  親密 ${gauge(a.scores.rapport)} ${Math.round(a.scores.rapport)}`)
      out.push(`開放 ${gauge(a.scores.openness)} ${Math.round(a.scores.openness)}  顔: ${FACE_LABEL[a.face]} ${a.mood}`)
      break
    case 'talk': {
      out.push('[会話]')
      for (const t of state.turns.slice(-4)) {
        const who = t.speaker === 'self' ? '自' : t.speaker === 'other' ? '相' : '？'
        out.push(fitLine(`${who}: ${t.text}`, W))
      }
      if (!state.turns.length) out.push('（まだ発話がありません）')
      break
    }
  }
  if (state.settings.debugOverlay) {
    const s = audio.stats
    out.push(fitLine(`dbg f=${s.frames} rms=${Math.round(s.lastRms)} tx=${s.ok}/${s.sent} err=${s.failed} q=${s.inFlight}`, W))
  }
  return out
}

let renderQueued = false
async function render() {
  if (renderQueued) return
  renderQueued = true
  await new Promise(r => window.setTimeout(r, 120)) // 表示更新のデバウンス
  renderQueued = false
  const view = buildView()
  ui.setGlassesMirror(`${view.gauges}\n────────────\n${view.panel}`)
  if (glasses) {
    try {
      await glasses.render(view, { micOn: state.micOn })
    } catch (e) {
      ui.log(`render failed: ${(e as Error).message}`)
    }
  }
}
