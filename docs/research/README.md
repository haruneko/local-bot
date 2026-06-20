# docs/research — 決定のための調査・証拠（非規範）

`docs/` 本体（CONCEPT/SPEC/DECISIONS/ACTION-DESIGN/ARCH-NEXT/MEMO-TREE/ROADMAP）が**規範＝正本**。ここは**その決定の裏づけ（証拠・eval・監査・調査）**を置く層。

## ルール

- ここの文書は **MUST を持たない**。docs 本体が出典として引くことはあるが、research が docs を上書きすることはない。
- **引用されたら凍結**：docs から参照されている調査は日付つきで固定し、後から書き換えない（証拠なので）。冒頭に `> 状態: cited by docs/X §Y / YYYY-MM-DD 凍結` を書く。
- 決定が docs/コードに取り込まれ、調査自体に証拠価値が残らないものは**削除**（docs が正本ならコピーは要らない）。
- **記事・発信用の下書きはここに置かない** → `article/`（gitignore・リポ外）。同じ調査が読み物と証拠の二役なら、散文は `article/`、決定事実だけ短い証拠版をここに。
- 再生成可能なダンプ（プロンプト全文ダンプ等）は置かない＝生成スクリプト（`scripts/`）を正本にする。

## 現在の収録

| ファイル | 出典/状態 |
|---|---|
| embedding-locate-eval-2026-06-17.md | CLAUDE.md §embed の証拠（記事版は article/） |
| vertex-migration-scoping-2026-06-18.md | ROADMAP の移行スコープ |
| merge-lang-intro-refutation-2026-06-18.md | DECISIONS/ARCH-NEXT/EFFECTORS-STEPS の反証 |
| recall-mechanical-2026-06-18.md / recall-baseline-2026-06-18.md | DECISIONS（recall 機械化）の before/after |
| code-structure-diagnosis-2026-06-18.md | コード構造の自己診断スナップショット |
| doc-staleness-audit-2026-06-18.md | docs 陳腐化監査スナップショット |
| activator-model-candidates-2026-06-18.md | activator 軽量モデル候補調査 |
