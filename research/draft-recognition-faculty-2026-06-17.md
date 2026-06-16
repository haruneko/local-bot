# ドラフト提案: recognition faculty（同一性の認識）の土台

> ステータス: **設計＋雛形提案（未配線）**。ハード（顔/声の埋め込み源）が無いと完結しないので、ここでは非ハード部分（entity 層スキーマ・seed・夢接続・想起との分離）を固める。

## コンセプト: recognition ≠ recall

- **recall（既存）** = 連想記憶。「いまの文脈に近い過去のエピソード/事実」を距離で引く。**誰/何か**は問わない。
- **recognition（未実装）** = 同一性の束縛。「この知覚（顔・声・物体）は、自分が知っている**あの個体 X** と同じだ」。`これはポチ` `この声はクロ`。
- 今のエバは entity モデルが無いので、画像の犬を過去の「ポチ」と**横断して同定できない**（毎回はじめまして）。横断embedding(ImageBind)は「似た景色」を引くが「同一個体」は別レイヤ（[[project-crossmodal-embedding]] の旧③を吸収）。

## 非ハード部分のスキーマ（雛形）

`data/lancedb` に `entities` テーブルを足す（情報源は recall と別）:

```ts
// src/recognition/entity.ts（雛形・未配線）
export type EntityKind = "person" | "pet" | "object" | "place";
export type Modality = "face" | "voice" | "image" | "text";

export type Entity = {
  id: string;            // 安定スラグ（"pochi", "kuro"）
  name: string;          // 表示名（ポチ / クロ）
  kind: EntityKind;
  aliases: string[];
  // モダリティごとの同定セントロイド（観測で更新する移動平均）。
  // 値はハード（ArcFace顔 / ECAPA声 / ImageBind画像）が出す埋め込み。未取得は無し。
  centroids: Partial<Record<Modality, number[]>>;
  notes?: string;        // 関係性の一文（users.yaml の note と同思想）
  firstSeen: string;
  lastSeen: string;
  observations: number;  // 同定回数（セントロイドの信頼度）
};

export type RecognitionHit = { entity: Entity; modality: Modality; distance: number };

/** 知覚の同定ベクトルを各entityのセントロイドと突き合わせ、閾値内で最も近い個体を返す。
 *  閾値超え＝未知（新規entity候補）。ハードのベクトル源が無い間は null を返すスタブ。 */
export interface RecognitionStore {
  recognize(modality: Modality, vector: number[], maxDistance: number): Promise<RecognitionHit | null>;
  observe(entityId: string, modality: Modality, vector: number[]): Promise<void>; // セントロイド更新
  upsert(entity: Omit<Entity, "firstSeen" | "lastSeen" | "observations">): Promise<void>;
}
```

## seed と夢の接続

- **seed**: `data/entities-seed.json`（semantic-seed と同思想）に既知個体を仕込む（クロ＝相棒AI・HAL/開発者・ポチ＝…）。`config/users.yaml` の話者 note は person entity に流用できる（話者ID→entity の橋渡し）。
- **夢（distill）の役割**: ハードの観測が貯まったら、夢が
  1. 同一個体の重複entityをマージ（セントロイドが近いもの）
  2. セントロイドを観測の移動平均で更新（経時変化への追従）
  3. entityにまつわる事実を意味記憶へ（「ポチは雨の日に吠える」等、外界 grounded のみ）
  を行う。recall/forget が「エピソードの符号化/減衰」なのに対し、recognition の夢は「個体像の更新」。

## 想起パイプラインへの差し込み（将来）

- 知覚チャンネル（image_feed/audio_feed）に同定ベクトルが付いたら、turn 前段で `recognize()` し、**entity context チャンネル**（「いま視界に: ポチ(確度高)、声: クロ」）を注入。これは episodic recall とは別チャンネル（RRF で混ぜない・性質が違う）。
- 話者ID（既存）は person entity の text モダリティ同定の特殊形＝既に部分的に recognition をやっている、と整理できる。

## 今やる範囲 / やらない範囲
- **やる（この提案）**: 概念整理・スキーマ・seed/夢の役割・想起との分離方針。
- **やらない（ハード待ち）**: 実セントロイドの埋め込み源（顔ArcFace/声ECAPA/画像ImageBind）。`recognize` はベクトル源が来るまでスタブ。配線（turn への entity channel 注入）もハード後。
- 雛形 `src/recognition/entity.ts` は**未配線のまま**置くか、ハード着手時に作るかは朝に判断（今はこのdocのスケッチに留め、production に未使用コードを増やさない方針を推奨）。

## 関連
- `docs/ARCH-NEXT.md`（recognition faculty 記載）、[[project-crossmodal-embedding]]（横断は cue・recognition は別faculty）、[[project-embodiment-arch]]（身体性）。
