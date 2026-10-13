// 開発用 Node サーバ。ラップトップで動かし、グラスアプリ(WebView)から LAN 経由で叩く。
// 本番は同じ app.ts を Cloudflare Workers(worker.ts)で動かす。
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'
import { createApp } from './app'
import { claudeCodeAvailable, claudeCodeProvider } from './claude-code'
import { configFromEnv } from './config'
import type { AnalyzeRequest } from '../shared/types'
import type { ExtraLlms } from './llm'

const PORT = Number(process.env.PORT || 8787)

const cfg = configFromEnv(process.env, {
  anthropicHasCreds: existsSync(join(homedir(), '.config', 'anthropic')),
})
// Claude Code がログイン済みならサブスク枠の `claude -p` を LLM に使う(auto 時の最優先)
const claudeVersion = cfg.llmProvider === 'mock' ? null : claudeCodeAvailable(cfg.claudeBin)
const extraLlm: ExtraLlms = claudeVersion
  ? { full: { 'claude-code': claudeCodeProvider(cfg, console.log, 'full') }, text: { 'claude-code': claudeCodeProvider(cfg, console.log, 'text') } }
  : {}
// RECORD_TURNS=1: /analyze に届いた発話を server/recordings/<日付>-<sessionKey>.txt に追記(`npm run compare -- --file` で再生できる形式)
const RECORD = process.env.RECORD_TURNS === '1'
const recDir = join(import.meta.dirname, 'recordings')
const recorded = new Map<string, number>()
function recordTurns(req: AnalyzeRequest) {
  const key = (req.sessionKey ?? 'nokey').replace(/[^\w.-]/g, '_')
  const last = recorded.get(key) ?? 0
  const fresh = req.turns.filter(t => t.id > last)
  if (!fresh.length) return
  mkdirSync(recDir, { recursive: true })
  const file = join(recDir, `${new Date().toISOString().slice(0, 10)}-${key}.txt`)
  appendFileSync(file, fresh.map(t => `${t.speaker}: ${t.text}`).join('\n') + '\n')
  recorded.set(key, req.turns.at(-1)!.id)
}

let app: ReturnType<typeof createApp>
try {
  app = createApp(cfg, { extraLlm, ...(RECORD ? { onAnalyze: recordTurns } : {}) })
} catch (e) {
  // 設定ミス(LLM_PROVIDER=jev でキー無し等)はスタックトレースではなく 1 行で出して止める
  console.error(`scouter proxy: 起動できません → ${(e as Error).message}`)
  process.exit(1)
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  const body = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' ? undefined : await readBody(req)
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
  const request = new Request(`http://localhost${req.url ?? '/'}`, {
    method: req.method,
    headers,
    body: body ? new Uint8Array(body) : undefined,
  })
  const response = await app.handle(request)
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  res.end(Buffer.from(await response.arrayBuffer()))
})

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter(n => n && n.family === 'IPv4' && !n.internal)
    .map(n => n!.address)
  console.log(`scouter proxy (node)  stt=${app.stt.name}  llm=${app.llm.name}${app.llm.name === 'claude-code' ? ` (${cfg.claudeCodeModel}/${cfg.claudeCodeEffort}, session=${cfg.claudeCodeSession ? 'on' : 'off'}, Claude Code ${claudeVersion})` : ''}  auth=${cfg.sharedSecret ? 'on' : 'off'}`)
  console.log(`  llm options (/analyze?provider=): ${Object.keys(app.llms).join(', ')}   stt gate: ${app.gate ? app.gate.name : 'off'}`)
  console.log(`  two-stage: ${app.llms.jev ? `on (fast=jev → text=${app.textLlm.name})` : 'off (TYPESAFE_API_KEY なし。従来の 1 段)'}`)
  if (RECORD) console.log(`  recording turns → ${recDir}/`)
  console.log(`listening on http://0.0.0.0:${PORT}`)
  for (const ip of ips) console.log(`  → http://${ip}:${PORT}  (app.json の whitelist / スマホ側設定に使う)`)
  if (app.stt.name === 'mock' || app.llm.name === 'mock') console.log('  ※ mock モード: server/.env に API キーを設定すると本物になります')
})
