import { z } from "zod";
import type { Env } from "../config/env.js";

const envelope = z.object({
  status: z.literal("completed"),
  output: z.array(
    z.object({
      type: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    }),
  ),
});

export type ModelConfig = Pick<
  Env,
  "OPENAI_API_KEY" | "OPENAI_MODEL" | "GEMINI_API_KEY" | "GEMINI_MODEL"
>;

export function modelProvider(env: ModelConfig): "gemini" | "openai" | "records" {
  if (env.GEMINI_API_KEY) return "gemini";
  return env.OPENAI_API_KEY ? "openai" : "records";
}

export async function requestStructuredOutput(
  env: ModelConfig,
  name: string,
  instructions: string,
  input: unknown,
  schema: object,
): Promise<unknown> {
  if (modelProvider(env) === "records") return null;
  try {
    if (env.GEMINI_API_KEY) {
      const model = encodeURIComponent(env.GEMINI_MODEL || "gemini-3.1-flash-lite");
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          signal: AbortSignal.timeout(10000),
          redirect: "error",
          headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: instructions }] },
            contents: [{ role: "user", parts: [{ text: JSON.stringify(input) }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseJsonSchema: schema,
              maxOutputTokens: 800,
            },
          }),
        },
      );
      if (!response.ok) {
        console.warn(`Gemini stock assistant request failed (HTTP ${response.status}).`);
        return null;
      }
      const body = z
        .object({
          candidates: z.array(
            z.object({
              finishReason: z.string(),
              content: z.object({
                parts: z.array(
                  z.object({ text: z.string().optional(), thought: z.boolean().optional() }),
                ),
              }),
            }),
          ),
        })
        .parse(await response.json());
      const candidate = body.candidates[0];
      if (candidate?.finishReason !== "STOP") return null;
      return JSON.parse(
        candidate.content.parts
          .filter((p) => !p.thought)
          .map((p) => p.text ?? "")
          .join(""),
      );
    }
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: AbortSignal.timeout(8000),
      redirect: "error",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || "gpt-4.1-mini",
        store: false,
        max_output_tokens: 200,
        instructions,
        input: JSON.stringify(input),
        text: { format: { type: "json_schema", name, strict: true, schema } },
      }),
    });
    if (!response.ok) return null;
    const body = envelope.parse(await response.json());
    const message = body.output.find((item) => item.type === "message");
    const text = message?.content?.find((part) => part.type === "output_text")?.text;
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
