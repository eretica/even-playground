// スマホ側(WebView)UI。グラス表示のミラー + 設定 + トランスクリプト + デバッグログ。
import type { Analysis, TranscriptTurn } from '../shared/types'
import type { Settings } from './storage'
import { faceCanvas, FACE_LABEL } from './face'

export type StatusKind = 'idle' | 'listening' | 'paused' | 'error' | 'noglasses'

export interface UiHandlers {
  onToggleMic: () => void
  onReset: () => void
  onSaveSettings: (s: Settings) => void
  onTestProxy: () => void
  onManualTurn: (speaker: 'self' | 'other', text: string) => void
  onNextPanel: () => void
}

let els: {
  status: HTMLElement
  chip: HTMLElement
  face: HTMLElement
  faceLabel: HTMLElement
  gauges: HTMLElement
  glassesText: HTMLElement
  score: HTMLElement
  suggestions: HTMLElement
  dig: HTMLElement
  summary: HTMLElement
  memory: HTMLElement
  transcript: HTMLElement
  log: HTMLElement
  micBtn: HTMLButtonElement
  proxy: HTMLInputElement
  proxyToken: HTMLInputElement
  lang: HTMLSelectElement
  unknownAs: HTMLSelectElement
  idle: HTMLInputElement
  analyzeInterval: HTMLInputElement
  chunkSec: HTMLInputElement
  debug: HTMLInputElement
  manualText: HTMLInputElement
  manualSpeaker: HTMLSelectElement
}

export function mountUi(h: UiHandlers, settings: Settings) {
  const app = document.querySelector<HTMLDivElement>('#app')!
  app.innerHTML = `
    <main class="wrap">
      <header>
        <div>
          <h1>Scouter</h1>
          <div id="status" class="sub">起動中…</div>
        </div>
        <div id="chip" class="chip chip-idle">IDLE</div>
      </header>

      <section class="card row">
        <div class="facebox">
          <div id="face"></div>
          <div id="faceLabel" class="sub">—</div>
        </div>
        <div class="gauges" id="gauges"></div>
      </section>

      <section class="card">
        <div class="cardhead"><span>グラス表示</span><button id="nextPanel" class="ghost">パネル切替</button></div>
        <pre id="glassesText" class="glass"></pre>
      </section>

      <section class="card">
        <div class="cardhead"><span>解析</span><span id="score" class="score">—</span></div>
        <div class="label">提案</div>
        <ul id="suggestions" class="list"></ul>
        <div class="label">深掘り</div>
        <ul id="dig" class="list"></ul>
        <div id="summary" class="sub"></div>
        <div class="label">持ち越しメモ(memory)</div>
        <div id="memory" class="sub"></div>
      </section>

      <section class="card">
        <div class="cardhead"><span>会話</span><button id="reset" class="ghost">リセット</button></div>
        <div id="transcript" class="transcript"></div>
        <div class="manual">
          <select id="manualSpeaker"><option value="other">相手</option><option value="self">自分</option></select>
          <input id="manualText" placeholder="テキストで発話を追加(テスト用)" />
          <button id="manualAdd" class="ghost">追加</button>
        </div>
      </section>

      <section class="card">
        <div class="cardhead"><span>設定</span><button id="testProxy" class="ghost">接続テスト</button></div>
        <label>解析サーバ URL<input id="proxy" placeholder="http://192.168.x.x:8787 / https://scouter-proxy.xxx.workers.dev" /></label>
        <label>サーバトークン(SHARED_SECRET。LAN 開発では空で可)<input id="proxyToken" type="password" autocomplete="off" /></label>
        <label>言語<select id="lang"><option value="ja">日本語</option><option value="en">English</option></select></label>
        <label>話者不明の音声<select id="unknownAs">
          <option value="unknown">そのまま(LLM に推定させる)</option>
          <option value="other">相手として扱う</option>
          <option value="self">自分として扱う</option>
        </select></label>
        <label>解析の最短間隔(秒。大きいほど Claude の枠を節約)<input id="analyzeInterval" type="number" min="2" max="60" /></label>
        <label>音声をまとめて送る長さ(秒。長いほど文の途中切れが減る)<input id="chunkSec" type="number" min="1" max="10" /></label>
        <label>無音で自動停止(分、0 で無効)<input id="idle" type="number" min="0" max="120" /></label>
        <label class="inline"><input id="debug" type="checkbox" /> グラスにデバッグ行を表示</label>
        <button id="save">保存</button>
      </section>

      <section class="card">
        <div class="cardhead"><span>ログ</span></div>
        <pre id="log" class="log"></pre>
      </section>

      <footer>
        <button id="mic" class="primary">マイク開始</button>
        <div class="sub">グラス: タップ = 開始 / パネル切替、長押し = メニュー、ダブルタップ = 終了</div>
      </footer>
    </main>
  `
  injectStyles()
  const q = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!
  els = {
    status: q('#status'), chip: q('#chip'), face: q('#face'), faceLabel: q('#faceLabel'),
    gauges: q('#gauges'), glassesText: q('#glassesText'), score: q('#score'),
    suggestions: q('#suggestions'), dig: q('#dig'), summary: q('#summary'), memory: q('#memory'),
    transcript: q('#transcript'), log: q('#log'), micBtn: q<HTMLButtonElement>('#mic'),
    proxy: q<HTMLInputElement>('#proxy'), proxyToken: q<HTMLInputElement>('#proxyToken'), lang: q<HTMLSelectElement>('#lang'),
    unknownAs: q<HTMLSelectElement>('#unknownAs'), idle: q<HTMLInputElement>('#idle'),
    analyzeInterval: q<HTMLInputElement>('#analyzeInterval'), chunkSec: q<HTMLInputElement>('#chunkSec'),
    debug: q<HTMLInputElement>('#debug'), manualText: q<HTMLInputElement>('#manualText'),
    manualSpeaker: q<HTMLSelectElement>('#manualSpeaker'),
  }
  fillSettings(settings)

  els.micBtn.addEventListener('click', h.onToggleMic)
  q('#reset').addEventListener('click', h.onReset)
  q('#nextPanel').addEventListener('click', h.onNextPanel)
  q('#testProxy').addEventListener('click', h.onTestProxy)
  q('#save').addEventListener('click', () => h.onSaveSettings(readSettings(settings)))
  const addManual = () => {
    const text = els.manualText.value.trim()
    if (!text) return
    h.onManualTurn(els.manualSpeaker.value as 'self' | 'other', text)
    els.manualText.value = ''
  }
  q('#manualAdd').addEventListener('click', addManual)
  els.manualText.addEventListener('keydown', e => { if (e.key === 'Enter') addManual() })
}

function fillSettings(s: Settings) {
  els.proxy.value = s.proxyUrl
  els.proxyToken.value = s.proxyToken
  els.lang.value = s.lang
  els.unknownAs.value = s.unknownAs
  els.idle.value = String(s.idleMinutes)
  els.analyzeInterval.value = String(s.analyzeIntervalSec)
  els.chunkSec.value = String(s.chunkSec)
  els.debug.checked = s.debugOverlay
}

function readSettings(base: Settings): Settings {
  return {
    ...base,
    proxyUrl: els.proxy.value.trim().replace(/\/+$/, ''),
    proxyToken: els.proxyToken.value.trim(),
    lang: els.lang.value,
    unknownAs: els.unknownAs.value as Settings['unknownAs'],
    idleMinutes: Math.max(0, Number(els.idle.value) || 0),
    analyzeIntervalSec: Math.min(60, Math.max(2, Number(els.analyzeInterval.value) || 4)),
    chunkSec: Math.min(10, Math.max(1, Number(els.chunkSec.value) || 4)),
    debugOverlay: els.debug.checked,
  }
}

export function setStatus(kind: StatusKind, text: string) {
  els.status.textContent = text
  const label: Record<StatusKind, string> = { idle: 'IDLE', listening: 'LISTENING', paused: 'PAUSED', error: 'ERROR', noglasses: 'NO GLASSES' }
  els.chip.className = `chip chip-${kind}`
  els.chip.textContent = label[kind]
  els.micBtn.textContent = kind === 'listening' ? 'マイク停止' : 'マイク開始'
}

export function setGlassesMirror(text: string) {
  els.glassesText.textContent = text
}

export function setAnalysis(a: Analysis) {
  els.face.replaceChildren(faceCanvas(a.face))
  els.faceLabel.textContent = `${FACE_LABEL[a.face]} · ${a.mood}`
  const e = a.emotions
  const bi: Array<[string, string, number]> = [['哀', '喜', e.joy - e.sorrow], ['怒', '楽', e.pleasure - e.anger]]
  const uni: Array<[string, number]> = [['関心', a.scores.engagement], ['本音', a.scores.openness]]
  const biRow = ([l, r, v]: [string, string, number]) => {
    const pct = Math.min(50, Math.abs(Math.round(v)) / 2)
    const style = v >= 0 ? `left:50%;width:${pct}%` : `left:${50 - pct}%;width:${pct}%`
    const sign = v > 0 ? `+${Math.round(v)}` : v < 0 ? `${Math.round(v)}` : '±0'
    return `<div class="g"><span class="gk">${l}</span><span class="gbar bi"><span class="gmid"></span><span class="gfill" style="${style}"></span></span><span class="gk">${r}</span><span class="gv">${sign}</span></div>`
  }
  const uniRow = ([k, v]: [string, number]) =>
    `<div class="g"><span class="gk wide">${k}</span><span class="gbar"><span class="gfill" style="left:0;width:${Math.round(v)}%"></span></span><span class="gv">${Math.round(v)}</span></div>`
  els.gauges.innerHTML = bi.map(biRow).join('') + uni.map(uniRow).join('')
  els.score.textContent = a.score ? `総合 ${Math.round(a.score)} · 関心 ${Math.round(a.scores.engagement)} · 親密 ${Math.round(a.scores.rapport)} · 開放 ${Math.round(a.scores.openness)}` : '—'
  els.suggestions.innerHTML = a.suggestions.map(s => `<li>${esc(s)}</li>`).join('') || '<li class="dim">—</li>'
  els.dig.innerHTML = a.digDeeper.map(s => `<li>${esc(s)}</li>`).join('') || '<li class="dim">—</li>'
  els.summary.textContent = a.summary
  els.memory.textContent = a.memory || '—'
}

export function setTranscript(turns: TranscriptTurn[]) {
  const tail = turns.slice(-40)
  els.transcript.innerHTML = tail.map(t => `
    <div class="turn turn-${t.speaker}"><span class="who">${t.speaker === 'self' ? '自分' : t.speaker === 'other' ? '相手' : '？'}</span>${esc(t.text)}</div>
  `).join('') || '<div class="dim">まだ発話がありません</div>'
  els.transcript.scrollTop = els.transcript.scrollHeight
}

const logLines: string[] = []
export function log(msg: string) {
  const ts = new Date().toTimeString().slice(0, 8)
  logLines.push(`${ts} ${msg}`)
  if (logLines.length > 200) logLines.shift()
  if (els?.log) {
    els.log.textContent = logLines.slice(-60).join('\n')
    els.log.scrollTop = els.log.scrollHeight
  }
  console.log('[scouter]', msg)
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

function injectStyles() {
  const css = `
    :root { color-scheme: dark; }
    html, body { margin: 0; background: #111; color: #fff;
      font: 15px/1.45 -apple-system, BlinkMacSystemFont, 'Helvetica Neue', system-ui, sans-serif; }
    .wrap { max-width: 640px; margin: 0 auto; padding: 16px 16px 96px; box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; overflow-x: hidden; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
    .sub { color: #8a8a8a; font-size: 12px; }
    .chip { font-size: 11px; letter-spacing: 0.04em; padding: 4px 10px; border-radius: 999px; border: 1px solid #3e3e3e; white-space: nowrap; }
    .chip-listening { color: #fef991; border-color: #fef991; background: rgba(254,249,145,0.08); }
    .chip-error { color: #ff453a; border-color: #ff453a; }
    .chip-noglasses { color: #8a8a8a; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 14px; box-sizing: border-box; max-width: 100%; }
    .cardhead { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-weight: 500; }
    .row { display: flex; gap: 14px; align-items: center; }
    .facebox { display: flex; flex-direction: column; align-items: center; gap: 4px; flex: 0 0 auto; }
    .facebox canvas { width: 96px; height: 96px; border-radius: 12px; background: #000; image-rendering: pixelated; }
    .gauges { flex: 1 1 auto; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .g { display: flex; align-items: center; gap: 8px; }
    .gk { width: 1.4em; font-weight: 600; flex: 0 0 auto; }
    .gk.wide { width: 2.6em; }
    .gbar { flex: 1; height: 10px; background: #2a2a2a; border-radius: 5px; overflow: hidden; position: relative; }
    .gfill { position: absolute; top: 0; height: 100%; background: #fef991; border-radius: 5px; transition: width .4s ease, left .4s ease; }
    .gmid { position: absolute; left: 50%; top: -2px; width: 2px; height: 14px; background: #8a8a8a; }
    .gv { width: 2.2em; text-align: right; font-variant-numeric: tabular-nums; color: #cfcfcf; }
    .glass { margin: 0; background: #000; color: #3cfa44; border-radius: 8px; padding: 10px; font: 13px/1.4 ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-all; min-height: 5.6em; }
    .score { font-size: 12px; color: #cfcfcf; font-weight: 400; }
    .label { font-size: 11px; color: #8a8a8a; letter-spacing: 0.04em; text-transform: uppercase; margin-top: 6px; }
    .list { margin: 4px 0 0; padding-left: 1.2em; }
    .list li { margin: 2px 0; }
    .dim { color: #666; list-style: none; margin-left: -1.2em; }
    .transcript { max-height: 220px; overflow: auto; display: flex; flex-direction: column; gap: 4px; font-size: 14px; }
    .turn { padding: 6px 8px; border-radius: 8px; background: #232323; }
    .turn-self { background: #1f1f1f; color: #bdbdbd; }
    .turn-other { background: #26261c; }
    .who { font-size: 11px; color: #8a8a8a; margin-right: 6px; }
    .manual { display: flex; gap: 6px; margin-top: 8px; }
    .manual input { flex: 1; min-width: 0; }
    label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #cfcfcf; margin: 8px 0; }
    label.inline { flex-direction: row; align-items: center; }
    input, select { background: rgba(255,255,255,0.08); border: 1px solid #3e3e3e; color: #fff; border-radius: 8px; padding: 8px 10px; font-size: 15px; box-sizing: border-box; max-width: 100%; }
    button { border: 0; border-radius: 10px; padding: 10px 14px; font-size: 15px; background: #2e2e2e; color: #fff; }
    button.primary { background: #fef991; color: #232323; font-weight: 600; width: 100%; padding: 14px; }
    button.ghost { background: transparent; border: 1px solid #3e3e3e; padding: 6px 10px; font-size: 13px; }
    .log { margin: 0; max-height: 200px; overflow: auto; font: 11px/1.4 ui-monospace, Menlo, monospace; color: #9a9a9a; white-space: pre-wrap; word-break: break-all; }
    footer { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); background: rgba(17,17,17,0.92); backdrop-filter: blur(8px); display: flex; flex-direction: column; gap: 6px; align-items: center; }
    footer .sub { text-align: center; }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
