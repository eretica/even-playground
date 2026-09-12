# 開発ワークフロー(環境構築 → 開発 → 実機 → 配布)

## 0. 一度だけやること

### ハードウェア
1. **出荷モード解除**: 両テンプルを充電ケースに入れて閉じる → ライトが白になったら開ける。
2. **ペアリング**: Even Realities App → Devices → Add device → Even G2 → グラス側の確認。
3. **ファームウェア更新を最初に**(接続トラブルの大半は古い FW)。Devices → Firmware。更新中はケースに入れたまま、スマホを近くに。
4. R1 リング(任意): Devices → Add device → Even R1。

### 開発者モード(トグルは無い)
1. https://hub.evenrealities.com/login にスマホアプリと同じアカウントでログイン(アカウント作成はアプリ側のみ)。
2. Even Realities App を**完全終了**(アプリスイッチャーからスワイプ)して再起動。
3. Even Hub タブ右上に「Scan QR」が出れば OK。

### ツール(導入済み)
```bash
npm i -g @evenrealities/evenhub-cli @evenrealities/evenhub-simulator
evenhub --version            # 0.1.14
evenhub-simulator --version  # 0.9.5
```

### Claude Code 公式プラグイン(任意・推奨)
```
/plugin marketplace add even-realities/everything-evenhub
/plugin install everything-evenhub@everything-evenhub
```
`/quickstart` `/template` `/glasses-ui` `/handle-input` `/device-features` `/test-with-simulator` `/simulator-automation` `/font-measurement` `/sdk-reference` `/cli-reference` `/design-guidelines` `/build-and-deploy` `/background-state` が使える。
中身は `docs/vendor/skills/` に写してあるので、未導入でも参照は可能。

## 1. プロジェクト作成

```bash
# テンプレから(推奨)。minimal / text-heavy / asr / image
npx degit even-realities/evenhub-templates/asr apps/my-app
cd apps/my-app && npm i
npm i @evenrealities/even_hub_sdk@latest      # テンプレは古い SDK 指定なので上げる
# 手動なら
npm create vite@latest my-app -- --template vanilla-ts && cd my-app && npm i @evenrealities/even_hub_sdk@latest && evenhub init
```

必須構成:
```
app.json            # マニフェスト(下記)
index.html          # Vite エントリ(viewport の zoom 固定は残す)
public/icon.png     # 24x24 グレースケール。ストア用は 1bit で 2x2 px ブロック単位
src/main.ts
vite.config.ts      # server: { host: true, port: 5173 }
```

`app.json` 最小形:
```json
{
  "package_id": "com.eretica.scouter",
  "edition": "202601",
  "name": "Scouter",
  "version": "0.1.0",
  "min_sdk_version": "0.0.15",
  "entrypoint": "index.html",
  "permissions": [
    { "name": "g2-microphone", "desc": "会話音声を解析して相手の状態を表示します。" },
    { "name": "network", "desc": "解析サーバへ送信します。", "whitelist": ["http://192.168.1.2:8787"] }
  ],
  "supported_languages": ["ja", "en"]
}
```
- `package_id`: 小文字英数 + ドット、2 セグメント以上、ハイフン不可。`name` は 20 文字以内。`version` は x.y.z。
- `permissions` は**オブジェクト配列**。`name` は `network | location | g2-microphone | phone-microphone | album | camera`。`desc` は 1〜300 文字。
- `supported_languages` は `en de fr es it zh ja ko` のみ。
- `min_app_version` は CLI が SDK から自動導出(手書き不要)。

## 2. ローカル開発(シミュレータ)

> このマシンでは 5173 を別プロジェクトの dev server が `[::1]` で常時使っている。scouter は 5180 固定。シミュレータには `http://127.0.0.1:<port>` を渡す(`localhost` だと `[::1]` 側に繋がることがある)。

```bash
npm run dev                                         # ターミナル 1
evenhub-simulator -g http://localhost:5173          # ターミナル 2
```
- 操作: ↑↓ = スワイプ、クリック = タップ、ダブルクリック = ダブルタップ、Ctrl 押しっぱなし = 長押し、右クリック = コンテキストメニュー。
- 画面クリックで RGBA PNG をカレントに保存。右クリック → Inspect Element で WebView の DevTools。
- マイク: `--list-audio-input-devices` で列挙 → `--aid <id>`。100ms ごとに 3200 byte の PCM が届く。
- `RUST_LOG=debug evenhub-simulator ...` で生ペイロードのログ。
- **HMR 後にイベントが届かなくなったら** `pkill -f evenhub-simulator` して再起動(古い `onEvenHubEvent` 登録が残る)。
- 同じ `--automation-port` で 2 つ起動すると 2 つ目は無言で死ぬ。起動前に必ず `pkill -f evenhub-simulator`。

### 自動化(HTTP API)
```bash
evenhub-simulator http://localhost:5173 --automation-port 9898
curl http://127.0.0.1:9898/api/ping                       # pong
curl http://127.0.0.1:9898/api/screenshot/glasses -o g.png # 576x288 RGBA(明るさは alpha に入る。RGB に変換しない)
curl http://127.0.0.1:9898/api/console                    # console / 例外 / fetch 失敗。?since_id=N で差分
curl -X POST http://127.0.0.1:9898/api/input -H 'Content-Type: application/json' -d '{"action":"click"}'
# action: up | down | click | double_click | long_press | long_press_release | context_menu(トグル)
```
起動から **4 秒以上**待ってから入力を送る(startup 前の入力は捨てられる)。

## 3. 実機テスト(QR サイドロード)

```bash
npm run dev
evenhub qr --url "http://$(ipconfig getifaddr en0):5173"   # en0 が空なら en1
```
スマホの Even Hub タブ → Scan QR → ターミナルの QR を読む。1 秒程度でグラスに描画、以後 HMR が効く。

`vite.config.ts` に HMR ホストを固定しておくとスマホ側で localhost 解決に失敗しない:
```ts
export default defineConfig({
  server: { host: true, port: 5173, hmr: { host: '192.168.1.2' } },  // 自分の LAN IP
  build: { target: 'esnext' },
})
```

つまずきポイント:
| 症状 | 原因 / 対処 |
|---|---|
| Scan 後「Couldn't connect」 | macOS ファイアウォールで node の受信を許可。同一サブネットか確認 |
| Scan 成功するが真っ黒 | Wi-Fi の AP 分離。スマホのテザリングに両方つなぐ or Tailscale |
| 初回真っ黒(シミュレータでは出る) | `await waitForEvenAppBridge()` 漏れ |
| コード変更後真っ黒 | QR を再スキャン(フルリロード) |
| タップが効かない | `isEventCapture: 1` 漏れ / `undefined` を CLICK として扱っていない |
| Dev Preview で Link 遷移が失敗 | 既知問題。QR 再スキャンで回避 |
| スマホをロック / 他アプリへ | WebView が停止し dev 接続が切れる(仕様) |

実機のコンソールログは Developer Mode 時にスマホアプリ内の dev console に出る。

## 4. パッケージと配布

```bash
npm run build
evenhub pack app.json dist --sdk-ver 0.0.15 -o scouter.ehpk   # -c で package_id の空き確認
```
- `.ehpk` は `app.json` + `dist` のスナップショット。**whitelist を変えたら再 pack**。
- 秘密情報(API キー)を同梱しない。Released 後は誰でも展開できる。
- 実用上の上限 ~10MB。
- アップロード: https://hub.evenrealities.com/hub → プロジェクト → Upload a build(changelog 500 文字まで)。
- テスト段階: Private(自分だけ、`.ehpk` の検証) → Beta(グループ共有、ロック画面 5 分放置テスト等) → Submit(レビュー。ロールバック不可、fix-forward のみ)。
- QA が見る所: ルート画面ダブルタップで終了ダイアログ / 5 分ロック後の復帰で状態・マイク・ソケットが生きているか / 権限説明文が実態と一致しているか。

## 5. STT / LLM を使うアプリの構成(このリポジトリの方針)

```
[G2 mic] --BLE--> [Even App WebView: apps/scouter/src] --fetch(LAN / Tailscale)--> [apps/scouter/server (Node on PC)] --> STT API / claude -p(サブスク)
```
- WebView から直接 API を叩かない(キー漏洩 + CORS)。プロキシ側で `Access-Control-Allow-Origin: *` と OPTIONS を返す。
- 音声は 2〜3 秒ぶんバッファして `POST /transcribe`(`Blob` body)。WebSocket は避ける。
- LLM は PC の Claude Code ログインを `claude -p --json-schema` で使う(API キー不要)。STT はキーかローカル whisper 互換サーバ。
- 外出先では Tailscale で PC に到達させる(固定 IP → whitelist に入れられる)。`SHARED_SECRET` を設定すると Bearer 認証が有効になる(スマホ側「サーバトークン」に同じ値)。
- 他人に配布するならプロキシを固定オリジン(Cloudflare Workers: `server/worker.ts`)にし、ユーザー自身のキーを設定させる設計に変える。
