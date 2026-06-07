import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ACTION_KINDS } from "../action/types.js";

export const abstractActionSchema = z.object({
  kind: z.enum(ACTION_KINDS),
  intent: z.string(),
});

export const judgeOutputSchema = z.object({
  reason: z.string().optional(),
  ACTION: z.union([abstractActionSchema, z.null()]),
  REPLY: z.boolean(),
  NEXT_STATE: z.string(),
});

export type JudgeOutputParsed = z.infer<typeof judgeOutputSchema>;

export const judgeJsonSchema = zodToJsonSchema(judgeOutputSchema, {
  name: "JudgeOutput",
  $refStrategy: "none",
});
