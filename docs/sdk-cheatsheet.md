# SDK チートシート(`@evenrealities/even_hub_sdk` 0.0.15)

完全な型は `docs/vendor/sdk/index.d.ts`、使用例は `docs/vendor/sdk/README.md`。

## 初期化

```ts
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
const bridge = await waitForEvenAppBridge()   // 必ず await。EvenAppBridge.getInstance() は非推奨
bridge.onLaunchSource(src => {})              // 'appMenu' | 'glassesMenu'(1 回だけ)
```

## bridge メソッド一覧

| メソッド | 戻り値 | メモ |
|---|---|---|
| `createStartUpPageContainer(c)` | `Promise<0\|1\|2\|3>` | 1 回だけ。0 成功 / 1 invalid / 2 oversize / 3 OOM |
| `rebuildPageContainer(c)` | `Promise<boolean>` | 全再描画(~165ms、一瞬ちらつく)。`menuObject` 省略でメニュー消える |
| `textContainerUpgrade(u)` | `Promise<boolean>` | 1 コンテナの文字だけ差し替え(~83ms、ちらつかない) |
| `updateImageRawData(d)` | `Promise<'success'\|'imageException'\|'imageSizeInvalid'\|'imageToGray4Failed'\|'sendFailed'>` | 直列のみ。LZ4 は自動 |
| `shutDownPageContainer(mode)` | `Promise<boolean>` | 0 即終了 / 1 確認ダイアログ(ルートは必ず 1) |
| `audioControl(on, source?)` | `Promise<boolean>` | `AudioInputSource.Glasses`(既定) / `.Phone` |
| `imuControl(on, pace?)` | `Promise<boolean>` | `ImuReportPace.P100..P1000`(プロトコル値、Hz ではない) |
| `getDeviceInfo()` | `Promise<DeviceInfo\|null>` | model / sn / status(battery, isWearing, isCharging, isInCase) |
| `onDeviceStatusChanged(cb)` | `() => void` | シミュレータでは発火しない |
| `getUserInfo()` | `Promise<UserInfo>` | uid / name / avatar / country |
| `setLocalStorage(k, v)` / `getLocalStorage(k)` | `boolean` / `string` | 無いキーは `""`。唯一信頼できる永続化 |
| `getAppLocation(opts)` / `startAppLocationUpdates(opts)` / `stopAppLocationUpdates()` / `onAppLocationChanged(cb)` | | `location` 権限 |
| `pickImageFromAlbum()` / `captureImageFromCamera()` | `Promise<AppImageAsset\|null>` | スマホ側。base64 で返る(巨大)。`album` / `camera` 権限 |
| `onEvenHubEvent(cb)` | `() => void` | 全イベントの入口 |
| `callEvenApp(method, params)` | `Promise<any>` | エスケープハッチ |

## コンテナ

共通: `xPosition yPosition width height containerID containerName(≤16) isEventCapture(0/1) zOrderIndex?`

| 種別 | 固有プロパティ | 上限 |
|---|---|---|
| `TextContainerProperty` | `content`, `borderWidth 0-5`, `borderColor 0-15`, `borderRadius 0-10`, `paddingLength 0-32`, `textColor 0-4` | text+list 合計 8。content: startup/rebuild 1000 字、upgrade 2000 字 |
| `ListContainerProperty` + `ListItemContainerProperty` | `itemCount 1-20`, `itemWidth`, `isItemSelectBorderEn`, `itemName: string[]`(各 ≤64 字) | 項目 20。in-place 更新不可(rebuild) |
| `ImageContainerProperty` | (border なし) | 4 個。20〜288 × 20〜144。`isEventCapture` 不可 |

ページ: `CreateStartUpPageContainer / RebuildPageContainer { containerTotalNum, textObject?, listObject?, imageObject?, menuObject? }`
メニュー: `menuObject: { menuItems: [{ itemName(≤32 bytes), itemID(非ゼロ uint32) }] }`(最大 10)
文字更新: `TextContainerUpgrade { containerID, containerName, content, contentOffset?: 0, contentLength?: 0, textColor? }`
画像更新: `{ containerID, containerName, imageData: number[] | Uint8Array | ArrayBuffer | base64 }`(PNG 等もそのまま可、内部で gray4 化)

`validateEvenHubPageContainer(page)` で送信前に検証できる。

## イベント(`EvenHubEvent`)

```ts
interface EvenHubEvent {
  textEvent?:          { containerID?, containerName?, eventType? }              // スクロール 1/2
  listEvent?:          { containerID?, containerName?, currentSelectItemIndex?, currentSelectItemName?, eventType? }
  sysEvent?:          { eventType?, eventSource?, imuData?: {x,y,z}, systemExitReasonCode? }
  audioEvent?:         { audioPcm: Uint8Array, source, direction: number|null, speakerRole: 'self'|'other'|'unknown' }
  menuItemClickEvent?: { itemID }
}
```

`OsEventTypeList`: 0 CLICK(→ `undefined` で届く) / 1 SCROLL_TOP / 2 SCROLL_BOTTOM / 3 DOUBLE_CLICK / 4 FOREGROUND_ENTER / 5 FOREGROUND_EXIT / 6 ABNORMAL_EXIT / 7 SYSTEM_EXIT / 8 IMU_DATA_REPORT / 9 LONG_PRESS / 10 LONG_PRESS_RELEASE
`EventSourceType`: 0 null / 1 glasses R / 2 ring / 3 glasses L

| 操作 | アクティブが text | アクティブが list |
|---|---|---|
| タップ | `sysEvent` (undefined/0) | `listEvent.currentSelectItemIndex` |
| ダブルタップ | `sysEvent` 3 | `sysEvent` 3 |
| スワイプ | `textEvent` 1/2(ファームがテキストをスクロール) | イベント無し(ファームが選択を移動) |
| 長押し | `sysEvent` 9 → 10、その後 OS メニュー | 同左 |

## 画面設計の小道具

- 行高 27px、全画面 288px → 最大 10 行(padding 分を引く)。1 行は半角 ~60〜70 字、全角 ~30 字が目安(プロポーショナルなので `@evenrealities/pretext` で測る)。
- ゲージ: `'━'.repeat(n) + '─'.repeat(10 - n)` / 縦: `█▇▆▅▄▃▂▁`
- ボタン風: `> 項目` / 選択: `borderWidth` トグル(rebuild が必要) / 中央寄せ: スペース詰め
- 使える記号: `▲△▶▷▼▽◀◁ ●○ ■□ ★☆ ◆◇ ◎ ╭╮╯╰│─ ♠♣♥♦ ━ ─ █ ▌ ▒`。絵文字は不可。
- スマホ側 UI の配色(Even デザイン): text `#232323`/`#FFF`、dim `#7B7B7B`、bg `#FFF`/`#111`、surface `#EEE`/`#1A1A1A`、アクセント黄 `#FEF991`(背景に使わない)、グラス緑 `#3CFA44` はスマホ UI に使わない。

## シミュレータ自動化 API(`--automation-port 9898`)

`GET /api/ping` / `GET /api/screenshot/glasses`(RGBA PNG、明るさ = alpha) / `GET /api/screenshot/webview` / `GET /api/console[?since_id=N]` / `DELETE /api/console` / `POST /api/input {action}`
action: `up down click double_click long_press long_press_release context_menu`

## CLI

```
evenhub init [-d dir] [-o path]
evenhub qr (-u url | -i ip -p port [--path p] [--https]) [-s scale] [-e] [--clear]
evenhub pack <app.json> <dist> [-o out.ehpk] [--sdk-ver 0.0.15] [-c] [--no-ignore] [--enforce-manual-version]
evenhub --completion-fish
```
