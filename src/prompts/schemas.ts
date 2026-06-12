import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const jsonSchemaOptions = { $refStrategy: "none" as const };

export const rememberOutputSchema = z.object({
  body: z.string().min(1),
});
export const rememberJsonSchema = zodToJsonSchema(rememberOutputSchema, {
  name: "RememberOutput",
  ...jsonSchemaOptions,
});

export const memoWriteOutputSchema = z.object({
  content: z.string().min(1),
  filename: z.string().optional(),
  /** true=既存メモへ追記（content は追記分のみ）。省略/false=新規作成 */
  append: z.boolean().optional(),
});
export const memoWriteJsonSchema = zodToJsonSchema(memoWriteOutputSchema, {
  name: "MemoWriteOutput",
  ...jsonSchemaOptions,
});

export const memoReadPickOutputSchema = z.object({
  filename: z.string().nullable(),
});

export const planOpSchema = z.object({
  op: z.enum([
    "new_goal",
    "complete",
    "reopen",
    "set_current",
    "add_milestone",
    "log",
    "noop",
  ]),
  id: z.string().optional(),
  text: z.string().optional(),
  title: z.string().optional(),
  goal: z.string().optional(),
  milestones: z.array(z.string()).optional(),
});
export const planOpJsonSchema = zodToJsonSchema(planOpSchema, {
  name: "PlanOp",
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

export const recallActionOutputSchema = z.object({
  bullets: z.array(z.string()),
});
export const recallActionJsonSchema = zodToJsonSchema(recallActionOutputSchema, {
  name: "RecallActionOutput",
  ...jsonSchemaOptions,
});

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
