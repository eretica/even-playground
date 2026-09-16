# Scouter 実機セットアップ手順(POC 用・公開不要)

PC(Mac)で解析サーバを動かし、Even G2 に QR サイドロードで Scouter を表示して遊ぶまでの全手順。
「1 回だけやること」→「毎回やること」→「グラスの操作」→「調整」→「困ったとき」の順。

---

## 0. 全体像

```
[Even G2] ─BLE─ [iPhone: Even App(WebView で Scouter が動く)]
                      │ Tailscale(または同じ Wi-Fi)
                      ▼
[Mac] npm run start:device
      ├ Vite :5180      … Scouter のページ配信 + HMR + /api の中継
      ├ プロキシ :8787   … 文字起こしと解析の窓口
      ├ whisper-server  … ローカル文字起こし(large-v3-turbo + VAD)
      └ claude -p       … 状態解析(Claude Code のサブスク枠)
```

- 音声は G2 のマイク → iPhone → Mac(Tailscale)→ whisper → Claude の順に流れ、結果がグラスに戻る。
- 外部サービスに送るものは無い(Claude への解析リクエストは Claude Code のログインを経由)。
- `.ehpk` の作成・ストア提出は不要。QR を読むだけ。

---

## 1. 一度だけやること

### 1-1. グラスと Even App

1. **出荷モード解除**: G2 の両テンプルを充電ケースに入れて閉じる → ライトが白になったら開ける。
2. **ペアリング**: Even App → Devices → Add device → Even G2 → グラス側で確認。R1 リングがあれば同様に追加。
3. **ファームウェア更新**: ペアリング直後に必ず実行(Devices → Firmware)。接続不良の大半は古い FW。更新中はケースに入れたまま、iPhone を近くに。
4. **Even App を 2.2.10 以上に更新**(SDK 0.0.15 の要件。App Store で更新)。

### 1-2. 開発者モード(トグルは無い)

1. iPhone か PC のブラウザで https://hub.evenrealities.com/login を開き、**Even App と同じアカウント**でログイン(アカウントはアプリでしか作れない)。
2. Even App を**完全終了**(アプリスイッチャーで上にスワイプ)して再起動。
3. Even Hub タブの右上に「**Scan QR**」が出れば有効。

### 1-3. Tailscale(外でも Mac に届くようにする)

1. Mac: `brew install --cask tailscale-app`(管理者パスワードが要る)→ Tailscale.app を起動してログイン(済)。
2. iPhone: App Store の **Tailscale** を入れ、Mac と同じアカウントでログイン → VPN を ON。
3. Mac で確認:
   ```bash
   cd apps/scouter && npm run netinfo
   # Tailscale IP: 100.x.y.z (<Mac名>.<tailnet>.ts.net) と出れば OK
   /Applications/Tailscale.app/Contents/MacOS/Tailscale status   # iPhone が一覧に並ぶ
   ```
4. iPhone の Safari で `http://100.x.y.z:5180` を開く(Mac 側で `npm run start:device` 中)。Scouter の画面が出れば経路は通っている。

同じ Wi-Fi にいるときは Tailscale 無しでも動く(起動スクリプトが LAN IP を使う)。

### 1-4. Mac 側のツール(済)

| もの | 状態 | 確認コマンド |
|---|---|---|
| Node 22 / npm | 済 | `node -v` |
| Even Hub CLI / simulator | 済(グローバル) | `evenhub --version`(0.1.14) / `evenhub-simulator --version`(0.9.5) |
| Claude Code(ログイン済み) | 済 | `claude --version` |
| whisper.cpp + モデル | 済 | `ls apps/scouter/server/models/`(`ggml-large-v3-turbo.bin`, `ggml-silero-v5.1.2.bin`) |
| 依存パッケージ | 済 | `cd apps/scouter && npm install` |

新しい Mac でやり直すときは `npm install` → `npm run whisper:setup`。

### 1-5. `server/.env`(任意)

無くても動く(STT = whisper、LLM = claude-code)。調整したいときだけ作る:
```bash
cd apps/scouter && cp server/.env.example server/.env
```
主なキー: `WHISPER_PROMPT`(用語集)、`CLAUDE_CODE_MODEL`(sonnet / opus / haiku)、`SESSION_MAX_CALLS`、`STT_PROVIDER`(whisper / gemini / openai / mock)。

---

## 2. 毎回やること

```bash
cd apps/scouter
npm run start:device
```

ターミナルに次が出る:
- `[server] scouter proxy (node) stt=whisper llm=claude-code …`
- `[whisper] …`(モデル読み込み。数秒)
- `[qr] 経路: tailscale アプリ: http://100.x.y.z:5180 プロキシ: http://100.x.y.z:8787`
- QR コード

iPhone の Even App → Even Hub タブ → **Scan QR** → ターミナルの QR を読む。1 秒ほどでグラスに「タップでマイク開始」が出る。

止めるときは Ctrl+C(プロキシ・whisper・Vite が全部止まる)。

### モックで動きだけ見る(サブスク枠を使わない)
```bash
npm run start:mock          # シミュレータで
```

---

## 3. グラスの操作

| 操作 | 動作 |
|---|---|
| タップ(マイク OFF 時) | マイク開始(聞き取り開始) |
| タップ(マイク ON 時)/ 下スワイプ | 下段パネルを次へ(メイン → 提案 → 深掘り → スコア → 会話) |
| 上スワイプ | 前のパネル |
| 長押し → メニュー | Mic ON/OFF、Next panel、Reset(会話をリセット)、Exit |
| ダブルタップ | 終了ダイアログ(「いいえ」で戻る) |

画面の見方:
```
┌ 顔 ──┬ 哀 ───────│━━────── 喜 +20   ← 0 中央の双極ゲージ
│      │ 怒 ───────│━━━───── 楽 +34
│      │ 関心 ━━━━━━──── 60          ← 単極
│      │ 本音 ━━━━───── 40
├──────┴──────────────────────────┤
│ ● 01:23 │ 総合 60 │ 喜び·上機嫌 │ LIVE  ← 経過時間 / 総合スコア / 顔·一言 / LIVE(=本物) or MOCK
│ ▶ 次に言う一言の提案                     │
│ ◆ 深掘り: 相手が触れて掘れていない話題    │
└──────────────────────────────────┘
```

---

## 4. iPhone 側の画面(Scouter のスマホ UI)

QR を読むと Even App 内に Scouter のスマホ画面も出る。

- 上: 顔・ゲージのミラー、ステータス(LISTENING / PAUSED / ERROR)
- 「グラス表示」: いまグラスに出ている文字そのもの
- 「解析」: 提案・深掘り・要約・**持ち越しメモ(memory)**
- 「会話」: 文字起こしログ(自分 / 相手 / ？)。テキスト入力で発話を手動追加してテストも可
- 「設定」: 解析サーバ URL(既定は同一オリジンの `/api`。触らなくてよい)、言語、**話者不明の扱い**、**解析の最短間隔**、**音声チャンク長**、無音自動停止、グラスにデバッグ行
- 「ログ」: 文字起こし・解析・エラーの時系列

設定は「保存」でグラス側ストレージに保存され、次回起動でも残る。

---

## 5. 調整の仕方

| 変えたいこと | 場所 | 反映 |
|---|---|---|
| 解析の頻度(枠の節約)、チャンク長、話者不明の扱い | iPhone の設定画面 | 即時 |
| 提案の口調・出力項目 | `apps/scouter/server/prompt.ts` | 保存でサーバ自動再起動(数秒) |
| モデル(sonnet/opus/haiku)、effort、セッション上限 | `server/.env` | 保存でサーバ自動再起動 |
| 固有名詞の誤認識(例: 網羅性 → モーラ性) | `server/.env` の `WHISPER_PROMPT=網羅性、スカウター、…` | `npm run start:device` を再起動 |
| グラスのレイアウト・文言 | `apps/scouter/src/main.ts`(パネル文面)、`src/glasses.ts`(座標) | 保存で HMR。効かなければ QR 再スキャン |
| ゲージや顔の見た目 | `src/text.ts`(ゲージ)、`src/face.ts`(顔) | 同上 |

やり取りを見る場所: Mac のターミナル(`[server]` 行に文字起こし結果と解析結果、`[claude-code] resume +N turns` に何発話まとめて送ったか)。外にいるときは Claude Code の Remote Control からこのターミナルのセッションに「ログ見せて」「間隔を 8 秒にして」と頼める。

---

## 6. 困ったとき

| 症状 | 見るところ / 対処 |
|---|---|
| Scan QR が無い | 1-2 をやり直す(ログイン → アプリ完全終了 → 再起動) |
| Scan 後「Couldn't connect」 | Mac のファイアウォールで node を許可。iPhone の Tailscale が ON か。`npm run netinfo` の IP と QR の IP が同じか |
| Scan できるが真っ黒 | Mac 側で `npm run start:device` が動いているか。Wi-Fi の AP 分離なら Tailscale か テザリング |
| グラス右上が `ERR` | iPhone 側「ログ」を見る。`proxy unreachable` ならサーバ未起動 / 経路不通 |
| `MOCK` と出る | サーバが mock で起動している(`start:mock` を使った、または whisper のモデルが無い) |
| 会話が全部 `？:` | `speakerRole` が unknown。実機の G2 マイクなら自他が付くはず。付かなければ Even App が古い |
| 顔が出ない・`face image failed` | 画像チャンネルの不具合。自動でテキスト顔に切り替わる(終了ダイアログ後に起きやすい) |
| 文字起こしが変 | `WHISPER_PROMPT` に用語を足す。周囲が騒がしいと精度が落ちる |
| 解析が遅い(10 秒超) | 設定の「解析の最短間隔」を伸ばす、`.env` で `CLAUDE_CODE_MODEL=haiku`(精度は落ちる) |
| `claude -p` のエラー | Mac で `claude` を一度起動してログイン状態を確認。サブスクの 5 時間枠切れなら待つ |
| iPhone をロックしたら止まった | 仕様(WebView 停止)。ロック解除 → 復帰しなければ QR 再スキャン |
| コードを直したのに変わらない | QR 再スキャン(フルリロード)。サーバ側は `[server]` の再起動ログを確認 |

---

## 7. 参考

- リポジトリの決まり事: `CLAUDE.md`
- SDK の落とし穴: `docs/pitfalls.md`、API 早見表: `docs/sdk-cheatsheet.md`
- 開発全般(シミュレータ、pack、提出): `docs/workflow.md`
- アプリの構成と設計: `apps/scouter/README.md`
