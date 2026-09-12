// 24x24 グレースケール PNG のアイコンを依存なしで生成する(スカウター風: 円 + 十字線)
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const W = 24, H = 24
const px = new Uint8Array(W * H)
const set = (x, y, v = 255) => { if (x >= 0 && x < W && y >= 0 && y < H) px[y * W + x] = v }

// 円(半径 9、中心 11.5)
const cx = 11.5, cy = 11.5
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const d = Math.hypot(x - cx, y - cy)
  if (d >= 8 && d < 10) set(x, y)
}
// 十字線
for (let i = 3; i < 21; i++) { if (Math.abs(i - 11.5) > 2.5) { set(i, 11); set(i, 12); set(11, i); set(12, i) } }
// 中央ドット
for (let y = 10; y <= 13; y++) for (let x = 10; x <= 13; x++) set(x, y)

function crc32(buf) {
  let c, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0 // 8bit, greyscale
const raw = Buffer.alloc((W + 1) * H)
for (let y = 0; y < H; y++) { raw[y * (W + 1)] = 0; Buffer.from(px.subarray(y * W, (y + 1) * W)).copy(raw, y * (W + 1) + 1) }
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
])
mkdirSync('public', { recursive: true })
writeFileSync('public/icon.png', png)
console.log('wrote public/icon.png', png.length, 'bytes')
