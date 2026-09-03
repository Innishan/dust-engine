import { GoogleGenAI } from "@google/genai";

export type XContentEvaluation = {
  relevance: number;
  usefulness: number;
  originality: number;
  genuineExperience: number;
  clarity: number;
  creativity: number;
  spamLikelihood: number;
  eligible: boolean;
  qualityScore: number;
};

export class RetryableQualityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableQualityError";
  }
}

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["relevance", "usefulness", "originality", "genuineExperience", "clarity", "creativity", "spamLikelihood", "eligible", "qualityScore"],
  properties: {
    relevance: { type: "number", minimum: 0, maximum: 100 },
    usefulness: { type: "number", minimum: 0, maximum: 100 },
    originality: { type: "number", minimum: 0, maximum: 100 },
    genuineExperience: { type: "number", minimum: 0, maximum: 100 },
    clarity: { type: "number", minimum: 0, maximum: 100 },
    creativity: { type: "number", minimum: 0, maximum: 100 },
    spamLikelihood: { type: "number", minimum: 0, maximum: 100 },
    eligible: { type: "boolean" },
    qualityScore: { type: "number", minimum: 0, maximum: 100 },
  },
} as const;

function isScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

export function parseXContentEvaluation(value: unknown): XContentEvaluation {
  if (!value || typeof value !== "object") throw new RetryableQualityError("Gemini returned malformed structured output");
  const evaluation = value as Record<string, unknown>;
  const scoreKeys = ["relevance", "usefulness", "originality", "genuineExperience", "clarity", "creativity", "spamLikelihood", "qualityScore"] as const;
  if (!scoreKeys.every((key) => isScore(evaluation[key])) || typeof evaluation.eligible !== "boolean") {
    throw new RetryableQualityError("Gemini returned invalid quality signals");
  }
  const score = (key: typeof scoreKeys[number]) => evaluation[key] as number;
  return {
    relevance: score("relevance"),
    usefulness: score("usefulness"),
    originality: score("originality"),
    genuineExperience: score("genuineExperience"),
    clarity: score("clarity"),
    creativity: score("creativity"),
    spamLikelihood: score("spamLikelihood"),
    eligible: evaluation.eligible,
    qualityScore: score("qualityScore"),
  };
}

export async function evaluateXContent({ content, context, apiKey, model }: {
  content: string;
  context?: string;
  apiKey?: string;
  model?: string;
}): Promise<XContentEvaluation> {
  if (!apiKey) throw new RetryableQualityError("Gemini evaluation is not configured");
  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: model || "gemini-2.5-flash",
      contents: `Classify this X post for an automated Dust Engine Ambassador program.\n\nThe post can qualify only when it is genuinely about Dust Engine and provides meaningful, original, useful, creative, or real-experience content. Reject pure mentions, irrelevant content, spam, copied/promotional noise, and empty repost commentary. Do not calculate points. Return only the requested JSON object.\n\nAuthor-written post:\n${content}\n${context ? `\nQuoted/referenced context (context only, not author-written content):\n${context}` : ""}`,
      config: { responseMimeType: "application/json", responseJsonSchema: schema },
    });
    if (typeof response.text !== "string") throw new RetryableQualityError("Gemini returned no structured response");
    return parseXContentEvaluation(JSON.parse(response.text));
  } catch (error) {
    if (error instanceof RetryableQualityError) throw error;
    throw new RetryableQualityError("Gemini evaluation temporarily failed");
  }
}
