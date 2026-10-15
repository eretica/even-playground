# Scouter × Jev 勉強会スライド(Marp)

`slides.md` が本体。VS Code の Marp 拡張でプレビューできる。書き出しは marp-cli(インストール不要、npx):

```bash
cd docs/slides/scouter-jev
npx @marp-team/marp-cli slides.md -o slides.html          # HTML(発表はこれをブラウザで。P で発表者ビュー、ノート付き)
npx @marp-team/marp-cli slides.md --allow-local-files --pdf -o slides.pdf      # PDF(Chrome を使う。ローカル画像を読むためのフラグ付き)
npx @marp-team/marp-cli slides.md --allow-local-files --pptx -o slides.pptx    # PowerPoint
npx @marp-team/marp-cli slides.md --allow-local-files --images png -o out/s.png  # 1 枚ずつ PNG(確認用)
npx @marp-team/marp-cli -s .                               # ライブプレビューサーバ
```

- 画像は `img/`(グラス・スマホのスクショ、構成図と二段表示の SVG)。
- 発表メモは各スライド末尾の HTML コメント。HTML 書き出しの発表者ビュー(P キー)に出る。
- `[リポジトリ URL]` と表紙の会名・日付は差し替える。
