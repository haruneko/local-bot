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
});
export const memoWriteJsonSchema = zodToJsonSchema(memoWriteOutputSchema, {
  name: "MemoWriteOutput",
  ...jsonSchemaOptions,
});

export const memoReadPickOutputSchema = z.object({
  filename: z.string().nullable(),
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
