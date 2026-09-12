# 引っかかりやすい所(落とし穴集)

出典: 公式 docs(2026-08)/ 公式 Claude Code スキル / SDK 0.0.15 型定義 / コミュニティ(nickustinov/even-g2-notes, tntpsu/Cue の KNOWN_QUIRKS)。
「実測」とあるものはコミュニティの実機計測で、環境により変わり得る。

## 起動・ライフサイクル

- **`createStartUpPageContainer` は 1 セッション 1 回**。失敗後の再呼び出しは ~2.1 秒ブロックして `invalid(1)` で拒否され、その間の入力は全部捨てられる。「呼んだ」フラグを成否に関わらず立て、以後は `rebuildPageContainer` に流す。終了時にフラグをリセット。
- 戻り値を捨てない。`0` 以外ならコンテナは存在せず、以後の画像送信が全部失敗して「画像のバグ」に見える。
- **終了ダイアログ中のイベント極性は逆転する**(実測): `shutDownPageContainer(1)` → ~100ms 後 `FOREGROUND_ENTER(4)`(ページはホスト側で消えている → rebuild の合図)→ 「いいえ」で `FOREGROUND_EXIT(5)`(バックグラウンドではない)→ 「はい」で `SYSTEM_EXIT(7)`。`shutDown` を呼ぶ時に同期でフラグを立て、答えが返るまで分岐する。
- 同じ物理遷移で sys イベントが **50〜100ms 間隔で二重に**来ることがある。(type, 時刻) で 600ms 程度デデュープ。
- 終了ダイアログを出した後、**画像チャンネルが詰まる**不具合報告あり(`updateImageRawData` が 1〜3ms で `sendFailed`、アプリ再起動まで回復しない)。回避策: ルートのダブルタップは直接 `shutDown(1)` せずメニュー経由にする等、露出を減らす。画像に依存しない UI にしておくのが安全。
- Android: バックグラウンドで WebView プロセスが回収され得る → コールドスタート扱い。iOS は JS 状態が残る。
- 公式スキル `background-state` が言う `setBackgroundState / onBackgroundRestore` は **SDK 0.0.15 の型定義に存在しない**。`FOREGROUND_ENTER_EVENT` で `getLocalStorage` から復元する方式にする。
- `onLaunchSource` は WebView ロード後に 1 回だけ(`appMenu` | `glassesMenu`)。reload では再送されない。

## イベント

- protobuf のゼロ値省略: `sysEvent.eventType` の CLICK(0)は `undefined`、`listEvent.currentSelectItemIndex` の 0 も `undefined`。
- タップ/ダブルタップは **`sysEvent`** に来る(text コンテナがアクティブでも)。`textEvent` はスクロール(1/2)のみ。シミュレータと実機で `sysEvent` / `textEvent` の出方が違うので**両方**見る。
- list コンテナがアクティブだとスクロールはファームが処理し、イベントは `listEvent` に来る。1×1 の隠し list はスクロールイベントを出さない(スクロールする物がない)。
- スワイプは連射される。300ms 程度のクールダウン。
- 長押しは `LONG_PRESS_EVENT(9)` と `LONG_PRESS_RELEASE_EVENT(10)` の 2 発。途中で rebuild してもペアは保たれる。
- 長押し → コンテキストメニュー(OS 描画)。カスタム項目は最大 10、`itemName` は **32 UTF-8 バイト**(日本語だと ~10 文字)、`itemID` は非ゼロ・一意。選択は `menuItemClickEvent.itemID` で来て、`isEventCapture` を経由しない。**`rebuildPageContainer` で `menuObject` を省くとメニューが消える**。メニューが必要なら毎回付ける。メニュー使用には Even App 2.2.9+。
- `eventSource`: 1 = 右テンプル, 3 = 左テンプル, 2 = リング。シミュレータは常に 1。
- シミュレータでは `onDeviceStatusChanged` は発火せず、`imuData` は常に null。

## 表示

- コンテナ上限: text/list 合計 8 + image 4。`containerName` 16 文字以内・ページ内一意。
- text の `content` 上限: startup/rebuild 1000 文字、upgrade 2000 文字。全画面で ~400〜500 文字。行高 27px 固定、左上寄せのみ。
- `zOrderIndex` は**全部つけるか全くつけないか**。混在は検証エラー。
- `textColor`(明るさ 0〜4、0.0.14+)は 0 が「最暗」であって未設定ではない。実機確認必須。`borderColor` は 0〜15 で別スケール。
- 背景塗りつぶしは不可(枠・文字・画像のみ)。黒 = 透過(現実が見える)。
- image: 20〜288 × 20〜144。作成時はプレースホルダで、必ず `updateImageRawData` する。同時送信不可。100ms 以内の連投はまとめられる。`createStartUpPageContainer` では画像データを送れない。
- フォントは 1 種類・プロポーショナル。範囲外の文字は**無言で消える**(豆腐も出ない)。絵文字・Dingbats・Misc Technical(⌚⏱)・☀☁ 等は無し。使えるのは ASCII/Latin、矢印 12 種、罫線(一重が中心)、`█▇▆▅▄▃▂▁ ▌ ▒`、`●○■□▲▼◆◇★☆◎`、♠♣♥♦ など。等幅が欲しければ全角(`　` と `Ａ-Ｚ０-９` 等)。
- 日本語: `supported_languages` に `ja` があり CJK 漢字は確認済みだが、**かな・句読点の網羅性は実機で確認**すること(コミュニティ表は 2025-02 のシミュレータ計測)。
- スクロールバーが勝手に出る → 末尾の `\n` や padding/border 分の高さ超過。`paddingLength` と `borderWidth` は四辺すべてから引かれる。`@evenrealities/pretext`(0.1.4)で `measureTextWrap` すると正確。
- 性能(実測): `textContainerUpgrade` ~83ms/回、`rebuildPageContainer` ~165ms(コンテナ数不問)、`updateImageRawData` ~104ms + 3.9ms/KB。→ 2 個以上同時に変えるなら rebuild。画像アニメは 1 コンテナで最大 ~9fps、複数コンテナは直列で遅い。
- BLE 呼び出しに数秒のタイムアウト(`Promise.race`)を付ける。1 回のハングで ~30 秒固まることがある。

## 音声

- PCM s16le / 16kHz / mono。`event.audioEvent.audioPcm: Uint8Array`。シミュレータは 100ms(3200B)単位。
- `AudioInputSource.Glasses` は startup ページ作成後でないと開けない。`Phone` は不要。権限は使う方だけ(`g2-microphone` / `phone-microphone`)。
- `audioEvent.speakerRole`(`self` / `other` / `unknown`, 0.0.14+)と `direction`(int16 or null)はアプリ側アルゴリズムの推定。Phone マイクや古いホストでは `unknown` / `null`。
- `audioControl(true)` の戻り値が true でも OS のマイク許可が無いとフレームは来ない。「N 秒フレーム無し」を UI に出す。
- バックグラウンドで停止する。復帰時に同じ source で再度 `audioControl(true)`。
- 音声セッション終了時、**末尾の未送信バッファを強制フラッシュ**する(短い発話が丸ごと落ちる典型バグ)。

## ネットワーク

- `app.json` whitelist(Even 側)**と** CORS(ブラウザ側)の二重ゲート。whitelist は CORS を回避しない。
- whitelist は完全オリジン(`https://api.example.com`)。ワイルドカード・裸ホスト不可。空配列だと `evenhub pack` が拒否。プレースホルダ URL は pack を通るが実行時にブロックされる。
- `http://` は LAN 開発時のみ。本番は https。
- iOS WKWebView で `new WebSocket()` のハンドシェイクが失敗する報告(Cue, SDK 0.0.10 時点)。**fetch + chunked POST** で設計する。バイナリ body は `ArrayBuffer` ではなく `Blob` で包む。
- シミュレータは whitelist を**一切強制しない**。「シミュレータで動くのに実機で fetch が落ちる」= ほぼ whitelist か CORS。
- バックグラウンド中は通信不可、プッシュ通知なし、`window.open` 相当なし。

## ストレージ

- ブラウザ `localStorage` / IndexedDB は `.ehpk` WebView で**永続しない/`open()` がハングする**報告。`bridge.setLocalStorage(key, string)` / `getLocalStorage(key)`(無ければ `""`)を使う。大きいデータはキー分割。
- ストレージは `package_id` ごとにサンドボックス。
- bridge のストレージ書き込みも BLE と同じ直列キューに入れ、デバウンスする。

## パッケージ / 提出

- `permissions` を map で書く / `edition` が `"202601"` 以外 / `name` 21 文字以上 / `version` が semver でない / `supported_languages` に未対応ロケール → 全部 validation error。
- 提出後は `app.json` を編集できない(Draft/Test のみ)。ホットフィックスもレビューを通る。
- ルート画面のダブルタップで `shutDownPageContainer(1)` を呼ばないと **レビューで却下**される。
