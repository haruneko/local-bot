import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const jsonSchemaOptions = { $refStrategy: "none" as const };

export const memoReadPickOutputSchema = z.object({
  filename: z.string().nullable(),
});

/** メモ本文への op（steps の op と同型・構造はコードが保証）。詳細は docs/MEMO-TREE.md */
export const memoOpSchema = z.object({
  op: z.enum([
    "view",
    "create",
    "append",
    "replace",
    "section_replace",
    "replace_line",
    "delete_line",
    "noop",
  ]),
  filename: z.string().optional(),
  content: z.string().optional(),
  old: z.string().optional(),
  heading: z.string().optional(),
  line: z.number().int().optional(),
});
export const memoOpJsonSchema = zodToJsonSchema(memoOpSchema, {
  name: "MemoOp",
  ...jsonSchemaOptions,
});

export const stepsOpSchema = z.object({
  op: z.enum([
    "new_goal",
    "view",
    "activate",
    "shelve",
    "retire",
    "complete",
    "reopen",
    "set_current",
    "add_milestone",
    "log",
    "noop",
  ]),
  /** 対象の計画 id（省略時 = いま集中している計画）。new_goal では生成される */
  stepsId: z.string().optional(),
  /** new_goal のみ: true で作って即開始（集中へ）／false（既定）は積むだけ */
  activate: z.boolean().optional(),
  id: z.string().optional(),
  text: z.string().optional(),
  title: z.string().optional(),
  goal: z.string().optional(),
  milestones: z.array(z.string()).optional(),
});
export const stepsOpJsonSchema = zodToJsonSchema(stepsOpSchema, {
  name: "StepsOp",
  ...jsonSchemaOptions,
});
/** steps processor の完了判定（1マイルストーンが成果物の中で満たされたか）。狭い二値。 */
export const stepsMilestoneJudgeSchema = z.object({
  satisfied: z.boolean(),
});
export const stepsMilestoneJudgeJsonSchema = zodToJsonSchema(stepsMilestoneJudgeSchema, {
  name: "StepsMilestoneJudge",
  ...jsonSchemaOptions,
});
export const memoReadPickJsonSchema = zodToJsonSchema(memoReadPickOutputSchema, {
  name: "MemoReadPickOutput",
  ...jsonSchemaOptions,
});

export const recallPresentSummarizeItemSchema = z.object({
  id: z.number(),
  presented: z.string(),
});

export const recallPresentSummarizeOutputSchema = z.object({
  items: z.array(recallPresentSummarizeItemSchema),
});
export const recallPresentSummarizeJsonSchema = zodToJsonSchema(
  recallPresentSummarizeOutputSchema,
  { name: "RecallPresentSummarizeOutput", ...jsonSchemaOptions },
);

export const forgetPickOutputSchema = z.object({
  turnId: z.string().nullable(),
  summary: z.string(),
});
export const forgetPickJsonSchema = zodToJsonSchema(forgetPickOutputSchema, {
  name: "ForgetPickOutput",
  ...jsonSchemaOptions,
});

export const dreamDistillFactSchema = z.object({
  body: z.string().min(1),
  tags: z.array(z.string()).optional(),
});

export const dreamDistillOutputSchema = z.object({
  facts: z.array(dreamDistillFactSchema),
});
export const dreamDistillJsonSchema = zodToJsonSchema(dreamDistillOutputSchema, {
  name: "DreamDistillOutput",
  ...jsonSchemaOptions,
});
