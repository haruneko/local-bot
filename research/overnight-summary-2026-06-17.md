# 夜間ジョブ総括（2026-06-17）

ブランチ `overnight`（main 未マージ・未push）。全工程でテスト緑を維持（最終 331 passed）。
判断が要る #3/#5 は適用せず提案ドラフトで停止。

## コード作業（実装・コミット済み）

### 1. コードベース堅牢化監査 ✅
`tools.test.ts` と同類の本番汚染バグを**もう1件発見・修正**:
- `tests/plan.test.ts` が凍結定数 `PLANS_DIR`/`NOTES_DIR` で**本物の data/plans・data/notes/goals に書いていた**（実行中の本番汚染・過去のゴール cruft の一因の可能性）。
- 修正: `plan/state.ts` に env 差し替え可能な `plansDir()`（`PLANS_DIR` 環境変数）／`roles/plan.ts` の goal mirror を `notesDir()` 経由／`plan.test.ts` を temp 隔離。
- **監査の結論**: 他にfsを書くテストは全て隔離済み・data 系パス(notes/plans/lancedb/state/dream/seed)は全て env/引数で隔離可・embed 次元のハードコード無し・言行不一致の成否ラベルは健在。クリーン。

### 2. hybrid 検索（lexical×vector）✅
名前そのままクエリに弱い意味ベクトルを、ファイル名の字句一致（文字バイグラムDice）で補強し RRF 融合。
- **実測（eval:retrieval --hybrid）**: 素朴な等重み融合は全体破壊（MRR 0.93→0.77）。**ゲート版（Dice>0.4 のときだけ融合）は name 0.87→1.00 で他kind無傷（ALL 0.93→0.94）**。
- 本番 `recallRecognizeTarget` にゲート版を配線（`LEXICAL_MIN_DICE=0.4`）。`src/recall/lexical.ts`・tests 追加。

### 6. semantic/dream の ruri 後検証 ✅
- 意味記憶想起、ruri で良好（関連事実 d≤0.32）。`semanticRecallMaxDistance` を nomic用 0.75→**0.45** に（ノイズ過剰注入を防ぐ）。
- `npm run dream` 正常動作（44エピソード→15意味記憶を蒸留・memo_index 5件取込・ruri embedDocument で符号化）。

### 4. eval graded nDCG（LLM-judge）✅
本採用 ruri の episode 想起を graded relevance（qwen判定）で検証（10クエリ・top5）:
- **precision@5 = 0.68 / nDCG@5 = 0.79**。8/10 が nDCG 0.96〜1.00、2問のみ 0.00（「今何時？」級の汎用/抽象クエリ）。アンカー一致(MRR0.56)を超えて実関連性能を裏付け。
- `scripts/episode-graded-ndcg.mts`（使い捨て検証）。

## 提案ドラフト（未適用・朝に判断）

### 3. 作話ナレーション抑制（#7）📝
`research/draft-anti-confab-search-narration-2026-06-17.md`。既存prompt は「無かったら正直に」はあるが「探した過程を盛る（隅々まで探した）」を止める文言が無い、が隙間。`prompts/roles.ts` に1行追加する保守的案＋実機プローブ手順。**適用は朝に**（トーンに効くため）。

### 5. recognition faculty 土台 📝
`research/draft-recognition-faculty-2026-06-17.md`。同一性「これはポチ」の entity 層スキーマ・seed/夢接続・recall との分離方針（設計のみ・本番未配線。ハードのベクトル源待ち）。

## 調査レポート（決定可能）

### R1. 目と首（webカメラ＋首振り）🔍
`research/eva-eye-neck-2026-06-17.md`。**推奨=ESP32-CAM（OV2640）＋SG90サーボ2軸の自作パンチルトLANリグ**。ESP32がLANにMJPEG＋HTTP制御APIを出し、エバが素のfetchで叩く。映像・制御ともLAN内完結で**ベンダークラウド不在＝プライバシー◎**、USBパススルー不要でWSL2相性◎。総額¥3,000〜4,000。落とし穴=サーボは外部5V＋GND共通＋平滑コンデンサ必須。

### R2. リビング遠隔マイク＆スピーカー 🔍
`research/eva-mic-speaker-2026-06-17.md`。**推奨=Raspberry Pi Zero 2W＋ReSpeaker Mic Array v3.0（XMOS XVF-3000・5m集音/ハードAEC・ビームフォーミング）＋有線アクティブSP を Wyoming プロトコルで母艦に繋ぐLANサテライト**。ASR/TTSは母艦ローカル（faster-whisper/Piper）＝**音声がクラウドに出ない**。合計約¥2万。廉価初手案=ReSpeaker 2-Mics Pi HAT(¥2,327)＋小型SPで検証から。

## 朝に決めてほしいこと
1. `overnight` ブランチを main にマージするか（コード=監査修正/hybrid/semantic閾値 は実改善・テスト緑）。
2. #3 作話抑制プロンプトを適用するか（実機プローブ込みで）。
3. R1/R2 のハード、どちらから着手するか（両方とも非クラウド前提で設計済み）。
4. #5 recognition と graded nDCG の本格運用は、それぞれハード/必要時に。

## コミット一覧（overnight ブランチ）
- 監査: plan のテスト隔離漏れ修正
- hybrid: memo locate に字句×意味のゲート融合
- semantic: semanticRecallMaxDistance を 0.45 に
- 夜間成果物: 調査2本＋ドラフト2本＋graded スクリプト
