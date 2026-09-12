# Scouter — 会話相手の状態をスカウター風に表示する G2 アプリ

会話を聞き取り、相手の「喜怒哀楽」ゲージ・顔アイコン・総合スコア・深掘りポイント・次の一言をグラスに出す。

```
[G2 mic] → Even App WebView(src/) → LAN / Tailscale → server/(Node on PC) ─ STT → OpenAI / Gemini / ローカル whisper
                                                                        └ LLM → claude -p(Claude Code サブスク枠)/ Anthropic / OpenAI / Gemini
```

**既定の本番構成は「自分の PC 上の Node プロキシ」。** LLM は Claude Code のログイン(サブスク)を `claude -p --json-schema` で使うので API キー不要。
STT だけはキーが要る(OpenAI か Gemini)か、ローカルの whisper 互換サーバを `OPENAI_STT_BASE_URL` で指す。

## 画面(576x288)

```
┌─ 顔 120px ─┬ 哀 ────────│━━━━━─── 喜 +57  ┐   ← 0 を中央にした双極ゲージ
│   (^ ^)    │ 怒 ────────│━━━━──── 楽 +44  │      (valence = 喜-哀, ease = 楽-怒)
│            │ 関心 ━━━━━━━─── 70             │   ← 単極
│            │ 本音 ━━━━────── 45             │
├────────────┴──────────────────────────┤
│ ● 01:23 │ 総合 78 │ 喜び·上機嫌 │ LIVE │
│ ▶ それで、その後どうなったんですか？     │
│ ◆ 深掘り: キャンプの帰りの渋滞の話      │
└───────────────────────────────────────┘
```

パネル(下段)はタップで切替: メイン → 提案 → 深掘り → スコア → 会話。

| 操作 | 動作 |
|---|---|
| タップ(マイク OFF 時) | マイク開始 |
| タップ(マイク ON 時)/ 下スワイプ | 次のパネル |
| 上スワイプ | 前のパネル |
| 長押し → メニュー | Mic ON/OFF, Next panel, Reset, Exit |
| ダブルタップ | 終了ダイアログ(ルート画面の必須動作) |

## 動かし方

```bash
cd apps/scouter
npm install
cp server/.env.example server/.env    # キーを入れる(無ければ mock で動く)

npm run start                         # プロキシ + Vite + シミュレータを 1 コマンドで(Ctrl+C で全部停止)
npm run start:mock                    # 同上、STT/LLM ともモック(API キー不要・サブスク枠も消費しない)

# 個別に動かす場合
npm run server                        # ターミナル 1: プロキシ :8787
npm run dev                           # ターミナル 2: Vite :5180
npm run sim                           # ターミナル 3: シミュレータ(マイク入力は --aid で選べる)
npm run qr                            # 実機: QR を出してスマホの Even Hub → Scan QR
```

シミュレータ起動時に macOS が `error messaging the mach port for IMKCFRunLoopWakeUpReliable` と出すことがあるが、これは OS の日本語入力(IME)まわりのログで無害。アプリの異常は `[scouter]` 行かグラス画面の `ERR` / `!` 行で判断する。

- スマホ側 UI の「解析サーバ URL」は既定で `http://<ページを配信しているホスト>:8787`(= ラップトップの LAN IP)。
- 実機で使う時は `app.json` の `whitelist` をその URL に合わせる(`npm run server` の起動ログに出る)。変えたら再 pack。
- HMR が実機で切れるなら `VITE_HMR_HOST=<LAN IP> npm run dev`。

### 必要なもの

| | 必要? |
|---|---|
| LLM(状態解析) | **キー不要**。Claude Code のログイン(サブスク)で `claude -p` が動く |
| STT(文字起こし) | `OPENAI_API_KEY` か `GEMINI_API_KEY` が必要。無ければ mock(決め打ちの日本語文) |
| 全部モックで動作確認 | `npm run start:mock`(何も要らない) |

### プロバイダ(auto の優先順)

| 役割 | 既定 | 切替 |
|---|---|---|
| STT | `OPENAI_API_KEY` があれば OpenAI(`gpt-4o-mini-transcribe`)→ `OPENAI_STT_BASE_URL` が変えてあればそのサーバ → Gemini → mock | `STT_PROVIDER` |
| LLM | **`claude` がログイン済みなら claude-code(`sonnet` / effort `low`)** → Anthropic API(`claude-opus-5`)→ OpenAI → Gemini → mock | `LLM_PROVIDER` |

- claude-code は**セッション継続モード**が既定(`CLAUDE_CODE_SESSION=1`)。初回だけ直近 `PROMPT_TURNS`(10)発話を渡してセッションを作り、以降は `--resume` で**新しい発話だけ**送る。1 回 約 3 秒、キャッシュヒット。`SESSION_MAX_CALLS`(40)回か `SESSION_MAX_MINUTES`(30)分で、`memory`(Claude が毎回更新する会話の要点)+ 直近発話を持って新セッションに巻き直す。`--resume` に失敗しても同じ手順で自動復旧。
- `CLAUDE_CODE_SESSION=0` にすると毎回独立(memory + 直近 10 発話)。API プロバイダ(anthropic/openai/gemini)は常にこの方式。
- 実測(sonnet/low): 1 回 6〜10 秒。内訳はほぼ Claude の生成時間(出力 約 500 トークン)。入力は空ディレクトリで起動して 4K トークン程度(リポジトリ内で起動すると CLAUDE.md 等が読み込まれ 18K に膨らむ)。`haiku` は構造化出力で再試行が増えて逆に遅かった(18 秒)ので既定は sonnet。`opus` は精度寄り。
- サブスクの枠は呼び出しごとに消費するので、長時間使うなら `ANALYZE_MIN_INTERVAL_MS`(`src/main.ts`、4 秒)を伸ばす。
- 生の `claude -p` 出力を見たいときは `node --import tsx scripts/claude-p-debug.ts [発話数]`。
- mock は音声を送ると決め打ちの日本語文を返し、キーワードでゲージを動かす。パイプライン確認用。

### 外出先から PC に届かせる

`app.json` の whitelist は pack 時に固定の完全オリジンなので、PC のアドレスが安定している必要がある。

1. **Tailscale(推奨)**: PC とスマホを同じ tailnet に入れる。PC の Tailscale IP(100.x.y.z)は固定なので `http://100.x.y.z:8787` を whitelist とスマホ側設定に入れる。インターネットに露出しない。
2. **Cloudflare Tunnel**: 自分のドメインで named tunnel を張れば `https://scouter.example.com` → PC の :8787。この場合は `SHARED_SECRET` を必ず設定する。

どちらも `.ehpk` を配布するわけではなく、自分の Even App から QR / Private ビルドで使う前提。

### Cloudflare Workers(代替。PC を起動しておきたくない場合)

同じ `server/app.ts` を `server/worker.ts` から動かせる(`wrangler.toml`)。ただし Workers では `claude -p` が使えないので LLM は API キー(Anthropic / OpenAI / Gemini)になる。
```bash
npx wrangler login
npx wrangler secret put SHARED_SECRET && npx wrangler secret put OPENAI_API_KEY && npx wrangler secret put ANTHROPIC_API_KEY
npm run worker:deploy      # → https://scouter-proxy.<account>.workers.dev
```

## 構成

| ファイル | 役割 |
|---|---|
| `src/main.ts` | 状態・操作・解析スケジューリング・パネル文面 |
| `src/glasses.ts` | G2 描画(直列キュー、差分更新、終了ダイアログの極性反転対応、画像 → テキスト顔フォールバック) |
| `src/audio.ts` | 話者別 PCM バッファ、無音判定、2.5 秒チャンクで POST |
| `src/face.ts` | 顔アイコン(Canvas → PNG)とテキスト版 |
| `src/text.ts` | pretext による折り返し・ゲージ生成 |
| `src/ui.ts` | スマホ側 UI |
| `src/storage.ts` | 設定の永続化(bridge.setLocalStorage) |
| `server/app.ts` | ルーティング本体(Web 標準 Request/Response。CORS、Bearer 認証、/health /transcribe /analyze) |
| `server/index.ts` | Node アダプタ(開発・PC 常駐用) |
| `server/worker.ts` + `wrangler.toml` | Cloudflare Workers アダプタ(代替) |
| `server/claude-code.ts` | `claude -p --json-schema` を LLM として使う(Node 専用) |
| `server/stt.ts` / `server/llm.ts` | API プロバイダ実装 |
| `server/config.ts` | 環境変数 → 設定(Node / Workers 共通) |
| `server/prompt.ts` / `server/schema.ts` | プロンプトと JSON スキーマ |
| `shared/types.ts` | 共有型 |

## 既知の制約 / TODO

- `speakerRole`(self/other)は Even App のアルゴリズム推定。シミュレータ・スマホマイクでは `unknown` になるので、設定で「相手として扱う」にするか LLM 推定に任せる。
- 顔アイコンは image コンテナ。終了ダイアログ後に画像チャンネルが詰まる報告があるため、失敗したらテキスト顔に自動切替する。
- 配布するならプロキシを固定オリジン(https)にし、ユーザー自身のキーを設定させる形に変える必要がある。
- 2 者以上の会話は「相手」をまとめて 1 人として扱っている。
