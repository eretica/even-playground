// Cloudflare Workers エントリ。app.ts をそのまま使う。
//   設定: wrangler.toml の [vars](公開値)と `wrangler secret put`(キー類)
//   必須 secret: SHARED_SECRET(アプリ側「サーバトークン」と同じ値)+ 使う API のキー
import { createApp, type App } from './app'
import { configFromEnv, type EnvLike } from './config'

let app: App | null = null
let appKey = ''

export default {
  async fetch(request: Request, env: EnvLike): Promise<Response> {
    // env はリクエストごとに渡されるが内容は同じ。設定が変わった時(デプロイ)だけ作り直す。
    const key = JSON.stringify(env)
    if (!app || key !== appKey) {
      app = createApp(configFromEnv(env))
      appKey = key
    }
    return app.handle(request)
  },
}
