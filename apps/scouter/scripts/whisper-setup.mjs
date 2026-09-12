// ローカル STT(whisper.cpp)のセットアップ: brew で whisper-server を入れ、モデルを server/models/ に落とす。
//   npm run whisper:setup            # large-v3-turbo(約 1.6GB、日本語向け・M シリーズなら実時間より速い)
//   npm run whisper:setup -- small   # 軽量モデルにしたい場合(精度は落ちる)
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const name = process.argv[2] || 'large-v3-turbo'
const file = `ggml-${name}.bin`
const dir = join(process.cwd(), 'server', 'models')
const dest = join(dir, file)
const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`

function has(cmd) {
  return spawnSync('which', [cmd], { encoding: 'utf8' }).status === 0
}

if (!has('whisper-server')) {
  console.log('[whisper] whisper-server が無いので brew install whisper-cpp を実行します')
  const r = spawnSync('brew', ['install', 'whisper-cpp'], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error('[whisper] brew install に失敗しました。手動で `brew install whisper-cpp` を実行してください')
    process.exit(1)
  }
} else {
  console.log('[whisper] whisper-server: インストール済み')
}

mkdirSync(dir, { recursive: true })
if (existsSync(dest) && statSync(dest).size > 1_000_000) {
  console.log(`[whisper] モデルあり: ${dest} (${(statSync(dest).size / 1e9).toFixed(2)} GB)`)
} else {
  console.log(`[whisper] モデルをダウンロード: ${url}`)
  const part = `${dest}.part`
  const r = spawnSync('curl', ['-L', '--progress-bar', '-o', part, url], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error('[whisper] ダウンロードに失敗しました')
    process.exit(1)
  }
  renameSync(part, dest)
  console.log(`[whisper] 保存: ${dest}`)
}

// VAD(発話検出)モデル。無音・雑音での幻聴を減らす。約 1MB
const vad = join(dir, 'ggml-silero-v5.1.2.bin')
if (!existsSync(vad)) {
  console.log('[whisper] VAD モデルをダウンロード')
  spawnSync('curl', ['-L', '--progress-bar', '-o', vad, 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin'], { stdio: 'inherit' })
}

console.log(`
[whisper] 準備完了。server/.env に次を書くと npm run start で whisper-server が自動起動します:
  STT_PROVIDER=whisper
  WHISPER_MODEL=server/models/${file}
`)
