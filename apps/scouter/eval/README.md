# 判定の評価セット

`npm run eval` が読む。1 ファイル 1 会話。アプリと同じく「発話が増えるたびに previous を渡して更新」する流れを再現し、
`=` 行(チェックポイント)でその時点の判定を正解と比べる。

```
# コメント
other: 最近仕事が忙しくて疲れました。
self: 大変ですね。
= face:tired mood:疲れ|退屈          ← この時点で期待する face(必須)と mood(任意、| で複数可)
```

- face: neutral / happy / angry / sad / relaxed / surprised / tired
- mood: server/jev.ts の MOODS のラベル(上機嫌 乗り気 落ち着き 様子見 警戒 退屈 疲れ 苛立ち 沈み 驚き)
- 実会話は `RECORD_TURNS=1` でサーバを起動すると `server/recordings/` に溜まるので、コピーして `=` 行を足す
- Jev はモデル版を固定できない(jev-latest / jev-preview のみ)。応答の model 名と一致率を控えておき、変わったらここで再確認する
