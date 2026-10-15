# even-playground — Even Realities G2 アプリ開発

Even G2 スマートグラス向け Even Hub アプリ(プラグイン)の実験リポジトリ。
詳細は `docs/` を参照。**まず本ファイル → 必要な docs だけ読む**(全部一度に読まない)。

| ドキュメント | 内容 |
|---|---|
| `docs/setup-device.md` | **実機で遊ぶための全手順**(グラス初期化、開発者モード、Tailscale、起動、操作、調整、困ったとき) |
| `docs/workflow.md` | 環境構築〜実機テスト〜パッケージまでの手順、トラブルシュート |
| `docs/pitfalls.md` | 引っかかりやすい所(実体験ベースのコミュニティ知見込み) |
| `docs/sdk-cheatsheet.md` | SDK API・制約値・イベント表の要約 |
| `docs/vendor/` | 公式 Claude Code スキル / SDK README / 型定義の写し(grep 用) |
| `docs/slides/scouter-jev/` | 勉強会スライド(Marp)。`slides.md` + `img/`、書き出し方は同階層の README |
| `apps/scouter/` | 会話相手の状態をスカウター風に表示するアプリ(本命) |

## 前提・バージョン(2026-09-12 時点)

- Node v22 / npm 10(asdf 管理)。CLI と simulator はグローバル導入済み。
- `@evenrealities/even_hub_sdk` **0.0.15**(要 Even App **2.2.10+**)。公式ドキュメントは 0.0.14 記述が混在。
- `@evenrealities/evenhub-cli` 0.1.14(`evenhub` / `eh`)、`@evenrealities/evenhub-simulator` 0.9.5
- 公式ドキュメント: https://hub.evenrealities.com/docs/ / テンプレ: `even-realities/evenhub-templates`
- 公式 Claude Code プラグイン: `/plugin marketplace add even-realities/everything-evenhub` → `/plugin install everything-evenhub@everything-evenhub`(未導入。導入すると `/glasses-ui` 等のスキルが使える)
- LAN IP の取得: `ipconfig getifaddr en0`

## アーキテクチャ(1 分版)

- アプリ = **スマホ上の Even App 内 WebView で動く Web アプリ**(Vite + TS)。グラスは BLE 越しの「表示 + 入力デバイス」で、ロジックは一切走らない。
- 画面: **576×288 px / 4bit 緑モノクロ**。CSS/DOM なし。絶対座標の「コンテナ」(text / list / image)を並べるだけ。
- 通信: `bridge.callEvenApp()` のラッパー群 → Even App → BLE → グラス。入力は `bridge.onEvenHubEvent()` に全部(タッチ・音声 PCM・IMU・ライフサイクル)が来る。
- ネットワーク: `app.json` の whitelist(Even 側ゲート)**かつ** ブラウザ CORS(サーバ側ヘッダ)の両方が必要。API キーは `.ehpk` に同梱しない → 自前プロキシを挟む。

## 基本コマンド

```bash
# scouter(apps/scouter)— 3 ターミナル
cd apps/scouter && npm i
npm run server        # 解析プロキシ :8787(server/.env にキー。無ければ mock)
npm run dev           # Vite :5180  ※5173 は別プロジェクトが [::1] で使用中のため 5180 固定
npm run sim           # evenhub-simulator -g http://localhost:5180
npm run sim:auto      # --automation-port 9898(curl で入力・スクショ・console)
npm run qr            # 実機 QR
npm run pack          # tsc + vite build + evenhub pack → scouter.ehpk

# 新規アプリ(テンプレ: minimal / text-heavy / asr / image)
npx degit even-realities/evenhub-templates/asr apps/<name> && cd apps/<name> && npm i
```

### シミュレータ検証の型(scouter で実証済み)
```bash
pkill -f evenhub-simulator; (npm run sim:auto &); sleep 8
curl -s localhost:9898/api/console | jq -r '.entries[] | select(.message|test("scouter")) | .message'
curl -s -X POST localhost:9898/api/input -H 'Content-Type: application/json' -d '{"action":"click"}'
curl -s localhost:9898/api/screenshot/glasses -o /tmp/g.png   # Read ツールで画像確認できる
```
- シミュレータは `localhost` を `[::1]` に解決することがある → URL は `http://127.0.0.1:5180` を使うと確実。
- **Vite の HMR 後はシミュレータを再起動する**(古い `onEvenHubEvent` 登録が残りタップが多重処理される。`glasses.ts` に `window.__scouterDispose` で保険あり)。
- シミュレータはマイク入力をラップトップの既定デバイスから流す(環境音でも RMS が閾値を超えて mock 文字起こしが流れる)。
- シミュレータでは `shutDownPageContainer(1)` の確認ダイアログは描画されず、ページが消えて入力が捨てられるだけ(実機ではダイアログが出る)。
- 日本語(かな・漢字)はシミュレータのフォントでは描画確認済み。実機は要確認。

## 絶対に守るルール(レビュー落ち・実機で詰む系)

1. `const bridge = await waitForEvenAppBridge()` を **必ず await** してから SDK を呼ぶ。`createStartUpPageContainer` は**セッションで 1 回だけ**(失敗しても再試行しない。以後は `rebuildPageContainer`)。
2. 各ページで `isEventCapture: 1` は**ちょうど 1 つ**。image コンテナは入力を受けない(裏に全画面の text を置く)。
3. **ルート画面のダブルタップは `shutDownPageContainer(1)`**(確認ダイアログ)。`0` は QA で落ちる。ダイアログ表示前にクリーンアップしない(キャンセルされ得る)。掃除は `SYSTEM_EXIT_EVENT(7)` / `ABNORMAL_EXIT_EVENT(6)` で。
4. **protobuf のゼロ値は `undefined` で届く**。単タップは `eventType === undefined` として来る。`?? 0` はイベント封筒の**中で**やる(封筒自体が無いときに CLICK と誤判定しない)。
5. **bridge 呼び出しは直列化する**(mutex/queue)。同時 `textContainerUpgrade` / `updateImageRawData` は BLE を落とす。表示更新は 100〜200ms でデバウンス。
6. 永続化は **`bridge.setLocalStorage/getLocalStorage`**。ブラウザの `localStorage`/IndexedDB は `.ehpk` WebView で消える・ハングする。
7. `textContainerUpgrade` の `containerID` と `containerName` は作成時と**完全一致**(不一致は無言で失敗)。`containerName` は 16 文字以内。
8. 文字はファームウェア内蔵 LVGL フォント 1 種のみ。**絵文字は描画されない**(無言で消える)。ゲージ等は `━ ─ █ ● ○ ■ □ ▲ ▼ ★ ☆` と罫線素片で作る。日本語(ひらがな・カタカナ・漢字)は `supported_languages: ["ja"]` が公式サポート範囲だが、**実機で必ず表示確認**する。
9. `app.json` の `permissions` は**オブジェクト配列**。network の whitelist は `https://host` 形式の完全オリジン(ワイルドカード不可、空配列不可)。変更したら**再 pack**。
10. iOS WKWebView では `new WebSocket()` が失敗した報告あり → ストリーミングは **chunked HTTP POST(`fetch` + `Blob` body)** で組む。
11. `audioControl(true)` の戻り値はマイク許可を意味しない。**PCM フレームが届いているか**で判定する。
12. Android は バックグラウンドで WebView が殺され得る。状態は `setLocalStorage` に逃がし、`FOREGROUND_ENTER_EVENT(4)` で再描画・音声再開。

## 実装の定石(コピペ用の型)

```ts
import { waitForEvenAppBridge, TextContainerProperty, CreateStartUpPageContainer, MenuContainerProperty, MenuItemProperty,
  ImageRawDataUpdate, TextContainerUpgrade, OsEventTypeList, AudioInputSource, AudioSpeakerRole } from '@evenrealities/even_hub_sdk'

const bridge = await waitForEvenAppBridge()
const r = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
  containerTotalNum: 1,
  textObject: [new TextContainerProperty({ xPosition: 0, yPosition: 0, width: 576, height: 288,
    containerID: 1, containerName: 'main', content: 'Hello', isEventCapture: 1, paddingLength: 4 })],
  // 長押しメニュー(任意)。型上は plain object 不可 → クラスで包む(ImageRawDataUpdate も同様)
  menuObject: new MenuContainerProperty({ menuItems: [new MenuItemProperty({ itemName: 'Reset', itemID: 1 })] }),
}))
if (r !== 0) console.error('startup failed', r)   // 0 ok / 1 invalid / 2 oversize / 3 OOM

const typeOf = (e?: { eventType?: number }) => e ? (e.eventType ?? OsEventTypeList.CLICK_EVENT) : null
bridge.onEvenHubEvent(ev => {
  if (ev.audioEvent?.audioPcm) { /* PCM s16le 16kHz mono, ev.audioEvent.speakerRole: self|other|unknown */ return }
  if (ev.menuItemClickEvent?.itemID) { /* メニュー */ return }
  const t = typeOf(ev.sysEvent) ?? typeOf(ev.textEvent)
  if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) { bridge.shutDownPageContainer(1); return }
  if (t === OsEventTypeList.CLICK_EVENT) { /* 単タップ */ }
  if (t === OsEventTypeList.SYSTEM_EXIT_EVENT || t === OsEventTypeList.ABNORMAL_EXIT_EVENT) { /* cleanup */ }
})
```

## 会話系アプリ固有の注意(scouter)

- マイク: `audioControl(true, AudioInputSource.Glasses)`(要 `g2-microphone` 権限、startup ページ作成後)。フレームごとに `speakerRole`(self/other/unknown)が付くので **相手の発話だけを抽出可能**(アプリ側アルゴリズムの推定であり保証なし)。
- STT/LLM の API キーはスマホに載せない。**PC 上のプロキシ(`apps/scouter/server`)** を叩く。開発中は Vite の `/api` プロキシ(同一オリジン)経由なので whitelist / CORS 不要。`.ehpk` 版だけ `app.json` の whitelist に `http://<PC の IP>:8787` が要る(`npm run whitelist` で LAN/Tailscale IP を同期)。
- 実機は `npm run start:device`(QR 表示、到達先は Tailscale > LAN)。Tailscale は `brew install --cask tailscale-app`(sudo 必要、ユーザーが実行)。
- **LLM は Claude Code のサブスク枠**: `server/claude-code.ts` が `claude -p --output-format json --json-schema … --tools "" --max-turns 4` を spawn する(`structured_output` を読む)。
  - stdin は必ず閉じる(`stdio: ['ignore', …]`)。`--bare` はキーチェーンを読まずログイン無し扱いになるので付けない。
  - `--max-turns 1` だと長い会話で `terminal_reason: max_turns` になり空振りする(構造化出力はツール呼び出しで前置きに 1 ターン使う)。
  - セッション継続: 初回 `--system-prompt` 付きでセッション作成 → 以降 `--resume <session_id>` に新しい発話だけ渡す(約 3 秒、cache hit)。`--resume` 時は system prompt を再送しない。上限で `memory` + 直近発話に巻き直す。
  - **空ディレクトリ(`os.tmpdir()/scouter-claude-p`)を cwd にして起動する**。リポジトリ内で起動すると CLAUDE.md / メモリが読み込まれ入力が 18K トークンになる(空 cwd で 4K)。
  - モデルが構造化出力の引数を `{"parameter": "<JSON文字列>"}` に包んでスキーマ不一致 → 再試行で 2 倍遅くなることがある。プロンプトで「トップレベルに直接入れる」と明記して解消。
  - 生出力の確認は `node --import tsx scripts/claude-p-debug.ts [発話数]`、ターン内訳は `STREAM=1` を付ける。
- **STT はローカル whisper.cpp が本線**(`brew install whisper-cpp` 済み、モデルは `apps/scouter/server/models/`、gitignore)。`npm run start` が `whisper-server --inference-path /v1/audio/transcriptions --vad` を自動起動し、プロキシは OpenAI 互換として叩く。1 チャンク 0.25 秒、日本語精度は良好。無音・雑音の幻聴は VAD + `dropHallucination` で抑止。
- Gemini API の無料枠は `gemini-3.6-flash` で **1 日 20 リクエスト**(実測)。このアプリには使えない。Google AI Pro は API 枠に効かず、Gemini CLI は起動 12 秒 + Workspace アカウントで `GOOGLE_CLOUD_PROJECT` 必須のため STT には不向き。
- サーバ本体は `server/app.ts`(Web 標準 Request/Response)。Node(`index.ts`)と Workers(`worker.ts`)は薄いアダプタ。プロバイダを足すときは `stt.ts` / `llm.ts` に `Config` を受け取る関数で追加する。
- **Jev(TypeSafe AI の判定専用モデル)は設定で切り替え**: `LLM_PROVIDER=jev`(判定のみ・文章欄空)/ `jev+claude-code`(Jev が喜怒哀楽・face・mood・スコア、LLM が助言・要約・memory)/ 従来のまま。実装は `server/jev.ts`、キーは `TYPESAFE_API_KEY`(waitlist)。
  - **解析は二段表示**(サーバに Jev があるとき自動): `POST /analyze?stage=fast`(Jev の数値だけ、0.2〜0.5 秒。発話のたび)→ `stage=text`(LLM の文章だけ。face が変わる / score が 15 以上動く / 30 秒経過 のときだけ、`analyzeIntervalSec` 以上の間隔)。クライアントは `/health` の `twoStage` で切り替える(`src/main.ts` の analyzeFast / maybeAnalyzeText)。LLM の文章モードは `SYSTEM_PROMPT_TEXT` + `TextSchema`(数値を出さない。judgement = Jev の判定を前提に書く)。
  - Jev の質問設計(公式の弱点一覧に従う): 各段階・選択肢は**観察できる状況**で書く(曖昧な形容詞禁止)、選択肢は `what / not_for` で隣接候補と境界を切る、state は直近 `JEV_TURNS`(既定 6)発話 + memory + `latest_other`(前回の face/mood は渡さない。渡すと固着する)、総合 score は Jev に聞かず `compositeScore` でコード計算、confidence < `JEV_MIN_CONFIDENCE`(0.5)の face / mood は前回値を保持(ヒステリシス)。
  - **評価セット `eval/*.txt`** + `npm run eval`: `=` 行で期待 face / mood を書く。2026-10-13 時点 6 会話 21 チェックポイントで face 21/21・mood 21/21、平均 0.3 秒、応答 model `jev-1.13.0`(API で指定できる名前は jev-latest / jev-preview のみで版固定不可。model 名が変わったら eval を回し直す)。実会話は `RECORD_TURNS=1` → `server/recordings/` → eval にコピーして `=` を足す。
  - 起動中は `POST /analyze?provider=<name>` で都度切り替え(`/health` の `llmOptions` に一覧)。並べて比較は `npm run compare -- --providers jev,claude-code -v`。性能は `npm run bench`、ゲート精度は `npm run gate-eval`。
  - `STT_GATE=jev` で文字起こし後に Noul「実発話か」を通し、`JEV_GATE_THRESHOLD`(0.6)未満を捨てる(正規表現の幻聴リストに追加で効く。両者は補完関係)。判定メモは `/transcribe` 応答の `note` → スマホのログに出る。ゲート自体の失敗は通過させてログに出す。
  - **whisper の文脈**: `WHISPER_CONTEXT=1`(既定)で直前の文字起こし末尾を次チャンクの `prompt` に繋ぐ(用語集 `WHISPER_PROMPT` と合わせてリクエストで渡す。whisper-server はリクエストの prompt が CLI の --prompt より優先)。4 秒境界で切れた「写真を撮るのが楽しくて」が、無しだと「コーディング」と幻聴、有りだと正しく続いた。
  - **実測(2026-10)**: Jev 判定 9 問 = 0.2〜0.5 秒、約 3,000 tok、1 時間の会話で 0.03 ドル。claude-code(sonnet/low、セッション継続)は文章モードでも **8〜10 秒**(CLI 起動 1.4 秒 + 7K トークンのシステムプロンプト + 2〜3 ターン。モデルを haiku にすると 20〜40 秒と逆に遅い、opus 12 秒)。速くするなら Anthropic API 直叩き(2〜3 秒見込み、サブスク枠外)か Agent SDK の常駐セッション。
  - キー無しで配線を試すニセ API: `node scripts/fake-jev.mjs` を立てて `TYPESAFE_API_KEY=fake TYPESAFE_BASE_URL=http://127.0.0.1:8799`。
- 表示更新コスト: `textContainerUpgrade` ≒ 83ms、`rebuildPageContainer` ≒ 165ms(コンテナ数に依らず一定)、画像 ≒ 104ms + サイズ。**3 つ以上のコンテナを同時に変えるなら rebuild の方が速い**。

## コーディング規約

- TypeScript strict、ESM、Vite。フレームワーク不要(素の TS で十分)。
- グラス描画は 1 ファイル(`glasses.ts` 等)に閉じ込め、**enqueue で直列化**した関数だけ公開する。
- 失敗は必ずグラス or スマホ画面に**見える形で**出す(無言のモックフォールバック禁止)。
- コミットは日本語 OK。秘密情報は `.env.local` / `server/.env` のみ(gitignore 済みか確認)。
