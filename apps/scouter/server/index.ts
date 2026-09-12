// 開発用 Node サーバ。ラップトップで動かし、グラスアプリ(WebView)から LAN 経由で叩く。
// 本番は同じ app.ts を Cloudflare Workers(worker.ts)で動かす。
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'
import { createApp } from './app'
import { claudeCodeAvailable, claudeCodeProvider } from './claude-code'
import { configFromEnv } from './config'
import type { LlmProvider } from './llm'

const PORT = Number(process.env.PORT || 8787)

const cfg = configFromEnv(process.env, {
  anthropicHasCreds: existsSync(join(homedir(), '.config', 'anthropic')),
})
// Claude Code がログイン済みならサブスク枠の `claude -p` を LLM に使う(auto 時の最優先)
const claudeVersion = cfg.llmProvider === 'mock' ? null : claudeCodeAvailable(cfg.claudeBin)
const extraLlm: Record<string, LlmProvider> = claudeVersion ? { 'claude-code': claudeCodeProvider(cfg, console.log) } : {}
const app = createApp(cfg, { extraLlm })

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
  console.log(`listening on http://0.0.0.0:${PORT}`)
  for (const ip of ips) console.log(`  → http://${ip}:${PORT}  (app.json の whitelist / スマホ側設定に使う)`)
  if (app.stt.name === 'mock' || app.llm.name === 'mock') console.log('  ※ mock モード: server/.env に API キーを設定すると本物になります')
})
