import type { ClipboardSnapshot } from "../../../../lib/readLatestClipboard";
import { firstModelSelectionId, resolveModelSelection } from "../../../../stores/aiModelsStore";
import type { AiModelProvider } from "../../../../stores/aiModelsStore";
import type { ModelConfig } from "../../assistant-ui/chatModel";
import { buildBearerAuthorization } from "../../../../lib/fetchHeaders";
import type {
  FormFillFieldDef,
  FormFillSimpleAIInput,
  FormFillSimpleAIResult,
  FormFillValue,
} from "./types";

export const FORM_FILL_SIMPLE_AI_SYSTEM_PROMPT = ``;

export type { FormFillFieldDef, FormFillSimpleAIInput, FormFillSimpleAIResult, FormFillValue };
export { buildFormFillZodSchema } from "./buildFormFillZodSchema";

export interface RunFormFillSimpleAIOptions {
  signal?: AbortSignal;
  systemPrompt?: string;
}

function buildUserPrompt(input: FormFillSimpleAIInput): string {
  const lines = [
    "## Source Content",
    input.sourceText.trim() || "(no text)",
  ];
  if (input.context?.trim()) {
    lines.push("", "## Additional Context", input.context.trim());
  }
  lines.push(
    "",
    "## Task",
    "Extract the values for each field from the source content above. Return ONLY a valid JSON object with the field keys and their values. For optional fields that cannot be determined, use null.",
  );
  return lines.join("\n");
}

function coerceFieldValue(raw: unknown, field: FormFillFieldDef): FormFillValue {
  if (raw === null || raw === undefined || raw === "") {
    return field.required ? "" : null;
  }
  switch (field.type) {
    case "number": {
      if (typeof raw === "number" && Number.isFinite(raw)) return raw;
      const n = Number(String(raw).trim());
      return Number.isFinite(n) ? n : null;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      const s = String(raw).trim().toLowerCase();
      if (["true", "1", "yes", "y", "是"].includes(s)) return true;
      if (["false", "0", "no", "n", "否"].includes(s)) return false;
      return null;
    }
    default:
      return String(raw);
  }
}

function buildJsonSchema(fields: FormFillFieldDef[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const field of fields) {
    const key = field.key.trim();
    let fieldType: string;
    switch (field.type) {
      case "number":
        fieldType = "number";
        break;
      case "boolean":
        fieldType = "boolean";
        break;
      default:
        fieldType = "string";
    }
    const desc = [field.label, field.description]
      .filter(Boolean)
      .join("；");
    properties[key] = {
      type: fieldType,
      description: desc,
    };
    if (field.required) {
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function normalizeValues(
  raw: Record<string, unknown>,
  fields: FormFillFieldDef[],
): Record<string, FormFillValue> {
  const values: Record<string, FormFillValue> = {};
  for (const field of fields) {
    values[field.key] = coerceFieldValue(raw[field.key], field);
  }
  return values;
}

export function formFillInputFromClipboard(
  snapshot: ClipboardSnapshot | null,
  fields: FormFillFieldDef[],
  context?: string,
): FormFillSimpleAIInput | null {
  if (!snapshot) return null;
  if (snapshot.kind === "text") {
    const text = snapshot.text.trim();
    if (!text) return null;
    return { sourceText: text, fields, context };
  }
  return {
    sourceText: "",
    imageUrl: snapshot.src,
    fields,
    context,
  };
}

export function resolveFormFillModelConfig(
  providers: AiModelProvider[],
  selectionId?: string | null,
): ModelConfig | null {
  const resolvedId =
    selectionId && resolveModelSelection(providers, selectionId)
      ? selectionId
      : firstModelSelectionId(providers);
  if (!resolvedId) return null;
  return resolveModelSelection(providers, resolvedId);
}

export async function runFormFillSimpleAI(
  modelConfig: ModelConfig,
  input: FormFillSimpleAIInput,
  options?: RunFormFillSimpleAIOptions,
): Promise<FormFillSimpleAIResult> {
  if (!input.fields.length) {
    throw new Error("FORM_FILL_NO_FIELDS");
  }
  if (!input.sourceText.trim() && !input.imageUrl) {
    throw new Error("FORM_FILL_NO_SOURCE");
  }

  const schema = buildJsonSchema(input.fields);
  const systemPrompt =
    options?.systemPrompt ??
    FORM_FILL_SIMPLE_AI_SYSTEM_PROMPT;

  const userPrompt = buildUserPrompt(input);
  const systemMessage = systemPrompt
    ? `${systemPrompt}\n\nYou must respond with a valid JSON object matching this schema:\n${JSON.stringify(schema, null, 2)}`
    : `You are a form-filling assistant. Extract field values from the source content. Respond with a valid JSON object matching this schema:\n${JSON.stringify(schema, null, 2)}`;

  const baseUrl = modelConfig.baseUrl.replace(/\/+$/, "");
  const url = baseUrl.includes("/v1")
    ? `${baseUrl}/chat/completions`
    : `${baseUrl}/v1/chat/completions`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: buildBearerAuthorization(modelConfig.apiKey),
    },
    body: JSON.stringify({
      model: modelConfig.name,
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    }),
    signal: options?.signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`API error ${response.status}: ${errorText || response.statusText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("FORM_FILL_EMPTY_RESPONSE");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new Error("FORM_FILL_PARSE_FAILED");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("FORM_FILL_EMPTY_RESPONSE");
  }

  return {
    values: normalizeValues(parsed, input.fields),
    raw: content,
  };
}
