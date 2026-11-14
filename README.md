# pi-subagent

[pi](https://pi.dev) 用のバックグラウンド・サブエージェント拡張。各サブエージェントは独立したコンテキストを持つ別の `pi` プロセスとして動く。pi v1.5.2 の `examples/extensions/subagent` を元に作り、以後は独自に開発している。

## インストール

```bash
pi install git:github.com/hiiamkazuto/pi-subagent
```

特定のバージョンに固定したい場合は、`@<tag>` または `@<commit>` を付ける。更新は `pi update --extensions` で行う。

## ツール

| ツール | 引数 | 説明 |
|---|---|---|
| `subagent` | `agent`, `task`, `cwd?`, `resume?` | 子をバックグラウンドで起動し、すぐに ID を返す。並列で動かしたいときは複数回呼ぶ。同時実行数に上限はない。 |
| `subagent_status` | なし | このセッションで起動した子の一覧と状態を返す。 |
| `subagent_result` | `id` | 子の出力を返す（50KB / 2000行で切り詰める）。子の使用量を親の合計に加算する。加算は1回の実行につき1度だけ。 |
| `subagent_stop` | `id` | 実行中の子を停止する（SIGTERM を送り、5秒後に SIGKILL）。途中までの出力は `subagent_result` で読め、`resume` で続きを依頼できる。 |

子が終わると、1行の完了通知が `followUp` として届き、親エージェントが次のターンを始める。

## エージェント

- 組み込みは `scout` と `worker`（`src/builtin-agents.ts` で定義）。
- `~/.pi/agent/agents/*.md` に置いたエージェントも読み込む。組み込みと同じ名前なら、そちらで上書きされる。
- frontmatter に書ける項目は `name`、`description`、`tools?`、`model?`（`provider/id` または `id`）、`thinking?`。
- `model` と `thinking` は省略すると親と同じ値になる。見つからないモデルを指定した場合は、親のモデルで実行し、結果に警告を付ける。

## セッション

- 子セッションは `~/.pi/agent/subagent-sessions/` に保存する。pi 標準の置き場とは別なので、`/resume` の一覧には出ない。実行 ID はセッション ID と同じ。
- `resume: <id>` を渡すと、同じエージェントと cwd でそのセッションの続きを依頼する。
- 親を再起動しても、結果はセッションファイルから読み直せる。
- 最終更新から7日を過ぎたファイルは、`session_start` のときに自動で削除する。
- 親の `session_shutdown` のときに、実行中の子はすべて停止する。

## 深さの制御

環境変数 `PI_SUBAGENT_DEPTH` は「この先まだ何段サブエージェントを作れるか」を表す。未設定なら1とみなす。子には「値−1」を渡し、値が1以上のときだけツールを登録する。デフォルトでは、子はサブエージェントを起動できない。

## 開発

手元の作業ツリーで動作確認するときは、インストールせずに `-e` で一時的に読み込む（git 版をインストール済みの場合はツール名が競合するので、先に `pi remove` で外しておく）。

```bash
git clone https://github.com/hiiamkazuto/pi-subagent.git
cd pi-subagent
npm install
pi -e ./src/index.ts
npm test          # vitest。本物の pi の代わりに test/fixtures/fake-pi.mjs を使う
npm run typecheck
```
