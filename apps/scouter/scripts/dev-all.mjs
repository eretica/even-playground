// プロキシ + Vite + シミュレータを 1 コマンドで起動する(npm run start)。
// Ctrl+C で全部止まる。ログは [server] [vite] [sim] のプレフィックス付き。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = 5180
// シミュレータに渡す追加オプション。例: npm run start -- --automation-port 9898
// `--` で始まらないもの(打ち間違いで混ざった "npm" など)は無視する
const rawArgs = process.argv.slice(2)
const SIM_ARGS = []
// --mock: STT も LLM もモックで起動(API キー不要、Claude のサブスク枠も消費しない)
const MOCK = rawArgs.includes('--mock')
// --no-sim: 実機で遊ぶとき(プロキシ + whisper + Vite だけ起動し、QR を表示)
const NO_SIM = rawArgs.includes('--no-sim')
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i]
  if (a === '--mock' || a === '--no-sim') continue
  if (a.startsWith('--')) {
    SIM_ARGS.push(a)
    if (!a.includes('=') && rawArgs[i + 1] && !rawArgs[i + 1].startsWith('--')) SIM_ARGS.push(rawArgs[++i])
  } else {
    process.stdout.write(`\x1b[33m[start]\x1b[0m 引数 "${a}" は無視しました(シミュレータのオプションは -- の後に --xxx 形式で渡す)\n`)
  }
}

const procs = []
function run(name, cmd, args, color, extraEnv = {}) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } })
  const tag = `\x1b[${color}m[${name}]\x1b[0m `
  const pipe = stream => {
    let buf = ''
    stream.on('data', d => {
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) process.stdout.write(tag + l + '\n')
    })
  }
  pipe(p.stdout)
  pipe(p.stderr)
  p.on('exit', code => process.stdout.write(`${tag}exited (${code})\n`))
  procs.push(p)
  return p
}

async function waitFor(url, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url)
      if (r.ok) return true
    } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}

// server/.env を軽く読む(サーバ本体は node --env-file で読むが、ここでは whisper を起動するかの判断に使う)
function readDotenv(path) {
  const out = {}
  if (!existsSync(path)) return out
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}
const dotenv = readDotenv('server/.env')
const envOf = k => process.env[k] ?? dotenv[k]

// ローカル whisper: STT_PROVIDER=whisper のとき、または auto でバイナリとモデルが揃っているとき自動起動
const WHISPER_MODEL = envOf('WHISPER_MODEL') || 'server/models/ggml-large-v3-turbo.bin'
const WHISPER_PORT = Number((envOf('WHISPER_URL') || 'http://127.0.0.1:8178/v1').match(/:(\d+)/)?.[1] || 8178)
const sttWant = (envOf('STT_PROVIDER') || 'auto').toLowerCase()
const hasWhisperBin = (await import('node:child_process')).spawnSync('which', ['whisper-server']).status === 0
const useWhisper = !MOCK && (sttWant === 'whisper' || (sttWant === 'auto' && hasWhisperBin && existsSync(WHISPER_MODEL)))

// 前回のシミュレータが残っていると入力が二重処理されるので先に落とす
if (!NO_SIM) spawn('pkill', ['-f', 'evenhub-simulator'])
await new Promise(r => setTimeout(r, 500))

// 既に別ターミナルでプロキシが動いていればそれを使う
if (await waitFor('http://127.0.0.1:8787/health', 500)) {
  const h = await fetch('http://127.0.0.1:8787/health').then(r => r.json()).catch(() => null)
  process.stdout.write(`\x1b[36m[server]\x1b[0m :8787 は既に起動済みなのでそちらを使います(stt=${h?.stt} llm=${h?.llm})${MOCK ? ' ※ --mock は既存サーバには効きません。止めてから起動し直してください' : ''}\n`)
} else {
  if (MOCK) process.stdout.write('\x1b[36m[server]\x1b[0m --mock: STT / LLM ともモックで起動します\n')
  if (useWhisper) {
    if (!hasWhisperBin || !existsSync(WHISPER_MODEL)) {
      process.stdout.write(`\x1b[31m[whisper]\x1b[0m whisper-server かモデル(${WHISPER_MODEL})が見つかりません。npm run whisper:setup を実行してください\n`)
    } else if (await waitFor(`http://127.0.0.1:${WHISPER_PORT}/`, 300)) {
      process.stdout.write(`\x1b[34m[whisper]\x1b[0m :${WHISPER_PORT} は既に起動済みなのでそちらを使います\n`)
    } else {
      // VAD モデルがあれば発話区間だけを認識させる(無音・雑音での幻聴を大幅に減らす)
      const vadModel = join('server', 'models', 'ggml-silero-v5.1.2.bin')
      const vadArgs = existsSync(vadModel) ? ['--vad', '--vad-model', vadModel] : []
      run('whisper', 'whisper-server', ['-m', WHISPER_MODEL, '-l', envOf('STT_LANGUAGE') || 'ja', '--host', '127.0.0.1', '--port', String(WHISPER_PORT),
        '--inference-path', '/v1/audio/transcriptions', '--no-timestamps', ...vadArgs], 34)
    }
  }
  run('server', 'node', ['--watch-path=server', '--watch-path=shared', '--env-file-if-exists=server/.env', '--import', 'tsx', 'server/index.ts'], 36,
    MOCK ? { STT_PROVIDER: 'mock', LLM_PROVIDER: 'mock' } : useWhisper ? { STT_PROVIDER: 'whisper' } : {})
}
// Vite も同様: 既に :5180 で動いていればそれを使う
let ok = await waitFor(`http://127.0.0.1:${PORT}/`, 500)
if (ok) {
  process.stdout.write(`\x1b[35m[vite]\x1b[0m :${PORT} は既に起動済みなのでそちらを使います\n`)
} else {
  run('vite', 'npx', ['vite', '--port', String(PORT), '--strictPort'], 35)
  ok = await waitFor(`http://127.0.0.1:${PORT}/`, 15000)
}
if (!ok) {
  process.stdout.write(`\x1b[31m[start]\x1b[0m Vite が :${PORT} で起動しませんでした。ポートが使用中か確認してください: lsof -nP -iTCP:${PORT}\n`)
} else if (NO_SIM) {
  // 実機用: QR を出す(スマホの Even Hub → Scan QR)
  const ip = (await import('node:child_process')).spawnSync('ipconfig', ['getifaddr', 'en0'], { encoding: 'utf8' }).stdout.trim()
    || (await import('node:child_process')).spawnSync('ipconfig', ['getifaddr', 'en1'], { encoding: 'utf8' }).stdout.trim()
  if (ip) {
    process.stdout.write(`\x1b[32m[qr]\x1b[0m http://${ip}:${PORT} をスマホで読み込みます(app.json の whitelist は http://${ip}:8787)\n`)
    run('qr', 'evenhub', ['qr', '--url', `http://${ip}:${PORT}`], 32)
  } else {
    process.stdout.write('\x1b[31m[qr]\x1b[0m LAN IP が取れませんでした。npm run qr を手で実行してください\n')
  }
} else {
  run('sim', 'evenhub-simulator', ['-g', `http://127.0.0.1:${PORT}`, ...SIM_ARGS], 32)
}

const shutdown = () => {
  for (const p of procs) p.kill('SIGTERM')
  setTimeout(() => process.exit(0), 500)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
