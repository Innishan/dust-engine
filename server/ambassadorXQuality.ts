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

export type XQualityFailureCategory = "configuration" | "provider_api_error" | "malformed_response" | "evaluation_error";
export type XQualityDiagnosticClass = "configuration_missing" | "provider_api_failure" | "malformed_evaluator_output" | "evaluation_failure";

export type XQualityFailureDiagnostic = {
  category: XQualityFailureCategory;
  diagnosticClass: XQualityDiagnosticClass;
  httpStatus?: number;
  providerCode?: string;
};

const SAFE_PROVIDER_CODES = new Set([
  "CANCELLED",
  "DEADLINE_EXCEEDED",
  "FAILED_PRECONDITION",
  "INTERNAL",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "UNAUTHENTICATED",
  "UNAVAILABLE",
  "UNKNOWN",
  "UNSUPPORTED_OPERATION",
]);

function safeProviderCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toUpperCase();
  return SAFE_PROVIDER_CODES.has(normalized) ? normalized : undefined;
}

function diagnosticClassFor(category: XQualityFailureCategory): XQualityDiagnosticClass {
  switch (category) {
    case "configuration": return "configuration_missing";
    case "provider_api_error": return "provider_api_failure";
    case "malformed_response": return "malformed_evaluator_output";
    default: return "evaluation_failure";
  }
}

export class RetryableQualityError extends Error {
  readonly diagnostic: XQualityFailureDiagnostic;

  constructor(message: string, diagnostic: Partial<XQualityFailureDiagnostic> = {}) {
    super(message);
    this.name = "RetryableQualityError";
    const category = diagnostic.category || "evaluation_error";
    this.diagnostic = {
      category,
      diagnosticClass: diagnostic.diagnosticClass || diagnosticClassFor(category),
      ...(Number.isInteger(diagnostic.httpStatus) && diagnostic.httpStatus! >= 400 && diagnostic.httpStatus! <= 599 ? { httpStatus: diagnostic.httpStatus } : {}),
      ...(safeProviderCode(diagnostic.providerCode) ? { providerCode: safeProviderCode(diagnostic.providerCode) } : {}),
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

export function classifyGeminiProviderFailure(error: unknown): RetryableQualityError {
  const root = asRecord(error);
  const response = asRecord(root?.response);
  const cause = asRecord(root?.cause);
  const statusValue = root?.status ?? root?.statusCode ?? response?.status ?? cause?.status;
  const parsedStatus = typeof statusValue === "number"
    ? statusValue
    : typeof statusValue === "string" && /^\d{3}$/.test(statusValue)
      ? Number(statusValue)
      : undefined;
  const codeValue = root?.code ?? cause?.code;
  const providerCode = safeProviderCode(codeValue);
  return new RetryableQualityError("Gemini evaluation temporarily failed", {
    category: "provider_api_error",
    diagnosticClass: "provider_api_failure",
    ...(parsedStatus !== undefined ? { httpStatus: parsedStatus } : {}),
    ...(providerCode ? { providerCode } : {}),
  });
}

export function parseXContentEvaluationText(text: string): XContentEvaluation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RetryableQualityError("Gemini returned malformed JSON", { category: "malformed_response" });
  }
  return parseXContentEvaluation(parsed);
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
  if (!value || typeof value !== "object") throw new RetryableQualityError("Gemini returned malformed structured output", { category: "malformed_response" });
  const evaluation = value as Record<string, unknown>;
  const scoreKeys = ["relevance", "usefulness", "originality", "genuineExperience", "clarity", "creativity", "spamLikelihood", "qualityScore"] as const;
  if (!scoreKeys.every((key) => isScore(evaluation[key])) || typeof evaluation.eligible !== "boolean") {
    throw new RetryableQualityError("Gemini returned invalid quality signals", { category: "malformed_response" });
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
  if (!apiKey) throw new RetryableQualityError("Gemini evaluation is not configured", { category: "configuration" });
  let response: { text?: string | null };
  try {
    const ai = new GoogleGenAI({ apiKey });
    response = await ai.models.generateContent({
      model: model || "gemini-2.5-flash",
      contents: `Classify this X post for an automated Dust Engine Ambassador program.\n\nThe post can qualify only when it is genuinely about Dust Engine and provides meaningful, original, useful, creative, or real-experience content. Reject pure mentions, irrelevant content, spam, copied/promotional noise, and empty repost commentary. Do not calculate points. Return only the requested JSON object.\n\nAuthor-written post:\n${content}\n${context ? `\nQuoted/referenced context (context only, not author-written content):\n${context}` : ""}`,
      config: { responseMimeType: "application/json", responseJsonSchema: schema },
    });
  } catch (error) {
    throw classifyGeminiProviderFailure(error);
  }
  if (typeof response.text !== "string") throw new RetryableQualityError("Gemini returned no structured response", { category: "malformed_response" });
  return parseXContentEvaluationText(response.text);
}
