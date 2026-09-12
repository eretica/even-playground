// 顔アイコン。Canvas で描いて PNG バイト列(number[])にする。ホスト側が 4bit グレーに変換する。
// 画像が使えない時のためのテキスト版も用意する。
import type { FaceKind } from '../shared/types'

export const FACE_SIZE = 120

const cache = new Map<FaceKind, number[]>()
const canvasCache = new Map<FaceKind, HTMLCanvasElement>()

export function faceCanvas(kind: FaceKind): HTMLCanvasElement {
  const hit = canvasCache.get(kind)
  if (hit) return hit
  const c = document.createElement('canvas')
  c.width = FACE_SIZE
  c.height = FACE_SIZE
  drawFace(c.getContext('2d')!, kind)
  canvasCache.set(kind, c)
  return c
}

/** PNG バイト列(updateImageRawData にそのまま渡せる) */
export function facePng(kind: FaceKind): number[] {
  const hit = cache.get(kind)
  if (hit) return hit
  const dataUrl = faceCanvas(kind).toDataURL('image/png')
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const bin = atob(b64)
  const bytes = new Array<number>(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  cache.set(kind, bytes)
  return bytes
}

function drawFace(ctx: CanvasRenderingContext2D, kind: FaceKind) {
  const S = FACE_SIZE
  const cx = S / 2
  const cy = S / 2
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, S, S)
  ctx.strokeStyle = '#fff'
  ctx.fillStyle = '#fff'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // 輪郭
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.arc(cx, cy, S / 2 - 6, 0, Math.PI * 2)
  ctx.stroke()

  const eyeY = cy - 12
  const eyeDx = 20
  const dot = (x: number, y: number, r: number) => {
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  const arc = (x: number, y: number, r: number, a0: number, a1: number, w = 5) => {
    ctx.lineWidth = w
    ctx.beginPath()
    ctx.arc(x, y, r, a0, a1)
    ctx.stroke()
  }
  const seg = (x0: number, y0: number, x1: number, y1: number, w = 5) => {
    ctx.lineWidth = w
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.stroke()
  }

  switch (kind) {
    case 'happy':
      // 笑い目(下向きの弧)+ 大きな口
      arc(cx - eyeDx, eyeY + 2, 8, Math.PI, 2 * Math.PI)
      arc(cx + eyeDx, eyeY + 2, 8, Math.PI, 2 * Math.PI)
      arc(cx, cy + 6, 26, 0.15 * Math.PI, 0.85 * Math.PI, 6)
      break
    case 'relaxed':
      // 穏やか: 細い目 + 軽い微笑み
      seg(cx - eyeDx - 8, eyeY, cx - eyeDx + 8, eyeY)
      seg(cx + eyeDx - 8, eyeY, cx + eyeDx + 8, eyeY)
      arc(cx, cy + 10, 20, 0.2 * Math.PI, 0.8 * Math.PI)
      break
    case 'angry':
      // つり眉 + 口をへの字
      seg(cx - eyeDx - 12, eyeY - 16, cx - eyeDx + 6, eyeY - 8)
      seg(cx + eyeDx + 12, eyeY - 16, cx + eyeDx - 6, eyeY - 8)
      dot(cx - eyeDx, eyeY + 2, 6)
      dot(cx + eyeDx, eyeY + 2, 6)
      arc(cx, cy + 40, 22, 1.2 * Math.PI, 1.8 * Math.PI, 6)
      break
    case 'sad':
      // 下がり眉 + 悲しい口 + 涙
      seg(cx - eyeDx - 10, eyeY - 8, cx - eyeDx + 8, eyeY - 16)
      seg(cx + eyeDx + 10, eyeY - 8, cx + eyeDx - 8, eyeY - 16)
      dot(cx - eyeDx, eyeY + 2, 6)
      dot(cx + eyeDx, eyeY + 2, 6)
      arc(cx, cy + 38, 18, 1.2 * Math.PI, 1.8 * Math.PI)
      dot(cx + eyeDx + 6, eyeY + 18, 4)
      break
    case 'surprised':
      // 丸い目 + 丸い口
      ctx.lineWidth = 4
      ctx.beginPath(); ctx.arc(cx - eyeDx, eyeY, 9, 0, Math.PI * 2); ctx.stroke()
      ctx.beginPath(); ctx.arc(cx + eyeDx, eyeY, 9, 0, Math.PI * 2); ctx.stroke()
      dot(cx - eyeDx, eyeY, 4)
      dot(cx + eyeDx, eyeY, 4)
      ctx.beginPath(); ctx.arc(cx, cy + 22, 10, 0, Math.PI * 2); ctx.stroke()
      break
    case 'tired':
      // 半目 + 平らな口
      arc(cx - eyeDx, eyeY - 4, 8, 0, Math.PI)
      arc(cx + eyeDx, eyeY - 4, 8, 0, Math.PI)
      seg(cx - 16, cy + 24, cx + 16, cy + 24)
      break
    case 'neutral':
    default:
      dot(cx - eyeDx, eyeY, 6)
      dot(cx + eyeDx, eyeY, 6)
      seg(cx - 18, cy + 22, cx + 18, cy + 22)
      break
  }
}

/** 画像が使えないときのテキスト顔(4 行) */
export function faceText(kind: FaceKind): string {
  const eyes: Record<FaceKind, string> = {
    neutral: '● ●',
    happy: '^ ^',
    relaxed: '─ ─',
    angry: '＼ ／',
    sad: '／ ＼',
    surprised: '○ ○',
    tired: '﹏ ﹏',
  }
  const mouth: Record<FaceKind, string> = {
    neutral: '──',
    happy: '◡',
    relaxed: '◡',
    angry: '︿',
    sad: '︿',
    surprised: '○',
    tired: '──',
  }
  return `╭────╮\n│ ${eyes[kind]} │\n│  ${mouth[kind]}  │\n╰────╯`
}

export const FACE_LABEL: Record<FaceKind, string> = {
  neutral: '平常',
  happy: '喜び',
  relaxed: '安らぎ',
  angry: '苛立ち',
  sad: '悲しみ',
  surprised: '驚き',
  tired: '疲れ',
}
