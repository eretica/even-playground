// グラス用テキスト整形。フォントはファーム内蔵の 1 種類のみ(プロポーショナル、全角 20px)。
// 幅は @evenrealities/pretext で実測に近い値を出す。
import { getTextWidth, pxTruncate } from '@evenrealities/pretext'

export const LINE_HEIGHT = 27

/** 指定ピクセル幅に収まるよう折り返す(単語境界を優先、無ければ文字単位) */
export function wrapPx(text: string, maxPx: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    const tokens = tokenize(para)
    for (const tok of tokens) {
      const candidate = line + tok
      if (getTextWidth(candidate) <= maxPx) {
        line = candidate
        continue
      }
      if (line) out.push(line.trimEnd())
      // 1 トークンが幅を超える場合は文字単位で割る
      if (getTextWidth(tok) > maxPx) {
        let piece = ''
        for (const ch of tok) {
          if (getTextWidth(piece + ch) > maxPx) { out.push(piece); piece = ch } else piece += ch
        }
        line = piece
      } else {
        line = tok.trimStart()
      }
    }
    out.push(line.trimEnd())
  }
  return out
}

/** 英単語は空白ごと、CJK は 1 文字ずつのトークンに分ける */
function tokenize(s: string): string[] {
  const tokens: string[] = []
  let buf = ''
  for (const ch of s) {
    if (isCjk(ch)) {
      if (buf) { tokens.push(buf); buf = '' }
      tokens.push(ch)
    } else if (ch === ' ') {
      buf += ch
      tokens.push(buf)
      buf = ''
    } else {
      buf += ch
    }
  }
  if (buf) tokens.push(buf)
  return tokens
}

function isCjk(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0
  return (c >= 0x3000 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef)
}

/** 1 行に収まるよう末尾を … で切る */
export function fitLine(text: string, maxPx: number): string {
  return pxTruncate(text, maxPx)
}

/** 最大行数に収め、足りなければ空行で埋めない(ちらつき防止のため末尾改行は付けない) */
export function clampLines(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) return lines
  const cut = lines.slice(0, maxLines)
  cut[maxLines - 1] = fitLine(cut[maxLines - 1] + '…', 9999)
  return cut
}

/** ━━━━──── 形式のゲージ(10 セグメント) */
export function gauge(value: number, segments = 10): string {
  const v = Math.max(0, Math.min(100, Math.round(value)))
  const filled = Math.round((v / 100) * segments)
  return '━'.repeat(filled) + '─'.repeat(segments - filled)
}

/**
 * 0 を中央にした双極ゲージ(-100..100)。左が負、右が正。
 *   -40 → ━━━━────│────────
 *   +60 → ────────│━━━━━───
 */
export function bipolarGauge(value: number, half = 7): string {
  const v = Math.max(-100, Math.min(100, Math.round(value)))
  const n = Math.round((Math.abs(v) / 100) * half)
  const left = v < 0 ? '─'.repeat(half - n) + '━'.repeat(n) : '─'.repeat(half)
  const right = v > 0 ? '━'.repeat(n) + '─'.repeat(half - n) : '─'.repeat(half)
  return `${left}│${right}`
}

/** +40 / -12 / ±0 */
export function signed(value: number): string {
  const v = Math.round(value)
  return v > 0 ? `+${v}` : v < 0 ? `${v}` : '±0'
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`
}
