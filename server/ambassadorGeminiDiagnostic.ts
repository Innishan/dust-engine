import { GoogleGenAI } from "@google/genai";
import { classifyGeminiProviderFailure } from "./ambassadorXQuality";

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
export const COMPARISON_GEMINI_MODEL = "gemini-3.5-flash";

type GeminiDiagnosticClient = {
  models: {
    get: (params: { model: string }) => Promise<unknown>;
    generateContent: (params: { model: string; contents: string; config: { maxOutputTokens: number } }) => Promise<unknown>;
  };
};

export type GeminiCheckResult = {
  success: boolean;
  category?: string;
  diagnosticClass?: string;
  httpStatus?: number;
  providerCode?: string;
  retryable?: boolean;
};

export type GeminiDiagnosticResult = {
  configured: boolean;
  effectiveModel: string;
  expectedModel: typeof DEFAULT_GEMINI_MODEL;
  effectiveModelMatchesExpected: boolean;
  modelAccess: GeminiCheckResult;
  generation: GeminiCheckResult;
  comparisonModel: typeof COMPARISON_GEMINI_MODEL;
  comparisonModelAccess: GeminiCheckResult;
  comparisonGeneration: GeminiCheckResult;
};

function failedCheck(error: unknown): GeminiCheckResult {
  const { diagnostic } = classifyGeminiProviderFailure(error);
  const status = diagnostic.httpStatus;
  return {
    success: false,
    category: diagnostic.category,
    diagnosticClass: diagnostic.diagnosticClass,
    ...(status !== undefined ? { httpStatus: status } : {}),
    ...(diagnostic.providerCode ? { providerCode: diagnostic.providerCode } : {}),
    retryable: status === undefined || status === 408 || status === 429 || status >= 500,
  };
}

export async function runGeminiDiagnostic(
  apiKey: string | undefined,
  effectiveModel: string,
  createClient: (key: string) => GeminiDiagnosticClient = (key) => new GoogleGenAI({ apiKey: key }),
): Promise<GeminiDiagnosticResult> {
  const result: GeminiDiagnosticResult = {
    configured: Boolean(apiKey),
    effectiveModel,
    expectedModel: DEFAULT_GEMINI_MODEL,
    effectiveModelMatchesExpected: effectiveModel === DEFAULT_GEMINI_MODEL,
    modelAccess: { success: false },
    generation: { success: false },
    comparisonModel: COMPARISON_GEMINI_MODEL,
    comparisonModelAccess: { success: false },
    comparisonGeneration: { success: false },
  };
  if (!apiKey) {
    result.modelAccess = { success: false, category: "configuration", diagnosticClass: "configuration_missing", retryable: false };
    result.generation = { ...result.modelAccess };
    result.comparisonModelAccess = { ...result.modelAccess };
    result.comparisonGeneration = { ...result.modelAccess };
    return result;
  }

  const ai = createClient(apiKey);
  const checkModel = async (model: string) => {
    let modelAccess: GeminiCheckResult;
    let generation: GeminiCheckResult;
    try {
      await ai.models.get({ model });
      modelAccess = { success: true };
    } catch (error) {
      modelAccess = failedCheck(error);
    }
    try {
      await ai.models.generateContent({
        model,
        contents: "Reply with the single word OK.",
        config: { maxOutputTokens: 8 },
      });
      generation = { success: true };
    } catch (error) {
      generation = failedCheck(error);
    }
    return { modelAccess, generation };
  };
  const effectiveResult = await checkModel(effectiveModel);
  result.modelAccess = effectiveResult.modelAccess;
  result.generation = effectiveResult.generation;
  const comparisonResult = await checkModel(COMPARISON_GEMINI_MODEL);
  result.comparisonModelAccess = comparisonResult.modelAccess;
  result.comparisonGeneration = comparisonResult.generation;
  return result;
}
