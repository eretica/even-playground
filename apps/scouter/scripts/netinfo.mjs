// PC の到達アドレス(LAN / Tailscale)を調べ、app.json の whitelist を同期する共通処理。
//   node scripts/netinfo.mjs            # 現在の IP と whitelist の状態を表示
//   node scripts/netinfo.mjs --sync     # whitelist に http://<ip>:8787 を追加(LAN と Tailscale の両方)
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const PROXY_PORT = 8787

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : ''
}

export function lanIp() {
  return sh('ipconfig', ['getifaddr', 'en0']) || sh('ipconfig', ['getifaddr', 'en1'])
}

export function tailscaleIp() {
  const bins = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']
  for (const b of bins) {
    const ip = sh(b, ['ip', '-4']).split('\n')[0]?.trim()
    if (ip && /^100\./.test(ip)) return ip
  }
  return ''
}

export function tailscaleDns() {
  const bins = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']
  for (const b of bins) {
    const out = sh(b, ['status', '--json'])
    if (!out) continue
    try {
      const j = JSON.parse(out)
      const name = j.Self?.DNSName?.replace(/\.$/, '')
      if (name) return name
    } catch {}
  }
  return ''
}

/** 実機からの到達先として使うホスト。--host 指定 > Tailscale > LAN */
export function pickHost(override) {
  if (override) return { ip: override, via: 'manual' }
  const ts = tailscaleIp()
  if (ts) return { ip: ts, via: 'tailscale' }
  const lan = lanIp()
  if (lan) return { ip: lan, via: 'lan' }
  return { ip: '', via: 'none' }
}

/** app.json の network whitelist に origin を足す(無ければ)。変更したら true */
export function ensureWhitelist(origin, file = 'app.json') {
  if (!existsSync(file)) return false
  const json = JSON.parse(readFileSync(file, 'utf8'))
  const net = (json.permissions ?? []).find(p => p.name === 'network')
  if (!net) return false
  net.whitelist ??= []
  if (net.whitelist.includes(origin)) return false
  net.whitelist.push(origin)
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n')
  return true
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const lan = lanIp()
  const ts = tailscaleIp()
  const dns = tailscaleDns()
  console.log(`LAN IP:        ${lan || '(なし)'}`)
  console.log(`Tailscale IP:  ${ts || '(未接続。Tailscale.app を開いてログイン)'}${dns ? `  (${dns})` : ''}`)
  const json = JSON.parse(readFileSync('app.json', 'utf8'))
  const wl = (json.permissions ?? []).find(p => p.name === 'network')?.whitelist ?? []
  console.log(`whitelist:     ${wl.join(', ') || '(空)'}`)
  if (process.argv.includes('--sync')) {
    let changed = false
    for (const ip of [lan, ts].filter(Boolean)) changed = ensureWhitelist(`http://${ip}:${PROXY_PORT}`) || changed
    console.log(changed ? 'app.json の whitelist を更新しました' : 'whitelist は最新です')
  }
}
