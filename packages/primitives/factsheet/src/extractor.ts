import type { ZodObject, ZodRawShape, ZodTypeAny } from "zod";
import {
  ExtractorCandidate,
  ExtractorConfig,
  ExtractorContext,
  ExtractorError,
  ExtractorResult,
  CustomExtractor,
} from "./types";

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

const DEFAULT_MAX_INPUT = 8000;
const DEFAULT_RETRIES = 2;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const sanitize = (text: string) => text.replace(CONTROL_CHARS, "");

function unwrap(schema: ZodTypeAny): ZodTypeAny {
  const typeName = schema?._def?.typeName;
  if (typeName === "ZodOptional" || typeName === "ZodNullable" || typeName === "ZodDefault") {
    return unwrap(schema._def.innerType);
  }
  if (typeName === "ZodEffects") {
    return unwrap(schema._def.schema);
  }
  return schema;
}

function describeSchema(schema: ZodTypeAny): any {
  const description = schema.description;
  const base = unwrap(schema);
  const effectiveDescription = description ?? base.description;
  const typeName = base?._def?.typeName;

  if (typeName === "ZodString") {
    return effectiveDescription ? `string (${effectiveDescription})` : "string";
  }
  if (typeName === "ZodNumber") {
    return effectiveDescription ? `number (${effectiveDescription})` : "number";
  }
  if (typeName === "ZodBoolean") {
    return effectiveDescription ? `boolean (${effectiveDescription})` : "boolean";
  }
  if (typeName === "ZodEnum") {
    const values = base._def.values.join(" | ");
    return effectiveDescription ? `enum<${values}> (${effectiveDescription})` : `enum<${values}>`;
  }
  if (typeName === "ZodNativeEnum") {
    const values = Object.values(base._def.values)
      .filter((v) => typeof v === "string")
      .join(" | ");
    return effectiveDescription ? `enum<${values}> (${effectiveDescription})` : `enum<${values}>`;
  }
  if (typeName === "ZodArray") {
    return [describeSchema(base._def.type)];
  }
  if (typeName === "ZodObject") {
    const shape = (base as any).shape as Record<string, ZodTypeAny>;
    const obj: Record<string, any> = {};
    for (const key of Object.keys(shape)) {
      obj[key] = describeSchema(shape[key]);
    }
    return obj;
  }
  if (typeName === "ZodRecord") {
    return { "[key]": describeSchema(base._def.valueType) };
  }

  if (typeName === "ZodDate") {
    return effectiveDescription ? `date (ISO 8601) (${effectiveDescription})` : "date (ISO 8601)";
  }
  if (typeName === "ZodBigInt") {
    return effectiveDescription ? `bigint (${effectiveDescription})` : "bigint";
  }
  if (typeName === "ZodTuple") {
    // Return a JSON-array-like structure describing each element in order
    return base._def.items.map((item: ZodTypeAny) => describeSchema(item));
  }
  if (typeName === "ZodSet") {
    const val = describeSchema(base._def.valueType);
    // Describe as array but note it is a Set
    const valStr = typeof val === "string" ? val : JSON.stringify(val);
    return effectiveDescription ? `set<${valStr}> (${effectiveDescription})` : `set<${valStr}>`;
  }
  if (typeName === "ZodMap") {
    const key = describeSchema(base._def.keyType);
    const val = describeSchema(base._def.valueType);
    const keyStr = typeof key === "string" ? key : JSON.stringify(key);
    const valStr = typeof val === "string" ? val : JSON.stringify(val);
    return effectiveDescription ? `map<${keyStr}, ${valStr}> (${effectiveDescription})` : `map<${keyStr}, ${valStr}>`;
  }

  return typeName ?? "unknown";
}

function buildPrompt(schema: ZodObject<ZodRawShape>): string {
  const structure = describeSchema(schema);

  return [
    "Extract structured facts as compact JSON with keys matching the schema.",
    "Use field descriptions and enum values to disambiguate.",
    "Only include fields you can confidently populate; omit unknowns.",
    "",
    "For each field, you may return either:",
    "- A plain value (if you are highly confident), OR",
    '- An object: { "value": <extracted>, "confidence": <0.0-1.0>, "inferred": <boolean> }',
    "  where confidence reflects certainty (1.0 = explicit, 0.5 = inferred, lower = uncertain),",
    "  and inferred = true if the value was deduced rather than explicitly stated.",
    "",
    "Respond with a single JSON object, no prose.",
    "Schema:",
    JSON.stringify(structure, null, 2),
  ].join("\n");
}

function parseLLMResponse(data: any): ExtractorResult {
  const rawMessage = data?.choices?.[0]?.message?.content;
  if (!rawMessage || typeof rawMessage !== "string") {
    return { candidates: [], rawResponse: data };
  }

  try {
    const parsed = JSON.parse(rawMessage);
    if (!parsed || typeof parsed !== "object") {
      return { candidates: [], rawResponse: data };
    }

    const candidates: ExtractorCandidate[] = [];
    for (const [field, rawValue] of Object.entries(parsed as Record<string, any>)) {
      if (rawValue === undefined) continue;

      if (rawValue && typeof rawValue === "object" && "value" in rawValue) {
        const value = (rawValue as any).value;
        const confidence = clamp01(Number((rawValue as any).confidence ?? 0.8));
        const inferred = Boolean((rawValue as any).inferred ?? false);
        candidates.push({ field, value, confidence, inferred });
      } else {
        candidates.push({ field, value: rawValue, confidence: 0.8, inferred: false });
      }
    }

    return { candidates, rawResponse: data };
  } catch {
    return { candidates: [], rawResponse: data };
  }
}

async function callCustom(
  custom: CustomExtractor,
  input: string,
  output: string | undefined,
  schema: ZodObject<ZodRawShape>,
  context: ExtractorContext
): Promise<ExtractorResult> {
  return custom(input, output, schema, context);
}

export class Extractor {
  constructor(private readonly config: ExtractorConfig) { }

  async extract(
    input: string,
    output: string | undefined,
    schema: ZodObject<ZodRawShape>,
    extractFromOverride?: "input" | "output" | "both"
  ): Promise<ExtractorResult> {
    const extractFrom = extractFromOverride ?? this.config.extractFrom ?? "input";
    if (extractFrom === "output" && output === undefined) {
      throw new Error("Extraction source is 'output' but no output provided");
    }

    const text =
      extractFrom === "output"
        ? (output as string)
        : extractFrom === "both"
          ? `${input}\n---\n${output ?? ""}`
          : input;

    const maxInputChars = this.config.maxInputChars ?? this.config.maxInputTokens ?? DEFAULT_MAX_INPUT;
    const sanitized = sanitize(text).slice(0, maxInputChars);

    if (this.config.custom) {
      const sanitizedOutput = output !== undefined ? sanitize(output) : undefined;
      const context: ExtractorContext = {
        extractFrom,
        maxInputChars,
        timeoutMs: this.config.timeoutMs ?? 5000,
        retries: this.config.retries ?? DEFAULT_RETRIES,
        onError: this.config.onError ?? "skip",
        rawInput: input,
        rawOutput: output,
      };
      return callCustom(this.config.custom, sanitized, sanitizedOutput, schema, context);
    }

    const body = {
      model: this.config.model,
      response_format: { type: "json_object" as const },
      messages: [
        { role: "system", content: buildPrompt(schema) },
        { role: "user", content: sanitized },
      ],
    };

    const retries = this.config.retries ?? DEFAULT_RETRIES;
    const onError = this.config.onError ?? "skip";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
      ...this.config.headers,
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.config.timeoutMs ?? 5000
      );

      try {
        const started = Date.now();
        const response = await fetch(`${this.config.baseURL}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        // Return structured error for non-2xx responses.
        if (!response.ok) {
          const text = await response.text();
          // Sanitize API Key from logs to prevent leakage if provider echoes request headers
          const sanitizedText = this.config.apiKey
            ? text.split(this.config.apiKey).join("[REDACTED]")
            : text;

          const isRetryable = response.status >= 500 || response.status === 429;
          return {
            candidates: [],
            rawResponse: { status: response.status, statusText: response.statusText, body: sanitizedText },
            latencyMs: Date.now() - started,
            error: {
              type: "api_error",
              status: response.status,
              statusText: response.statusText,
              message: sanitizedText || response.statusText,
              retryable: isRetryable,
            },
          };
        }

        const data = await response.json();
        const parsed = parseLLMResponse(data);
        parsed.latencyMs = Date.now() - started;
        return parsed;
      } catch (error) {
        clearTimeout(timeout);
        lastError = error;
        if (attempt === retries) break;
      }
    }

    if (onError === "throw" && lastError) {
      throw lastError;
    }

    // Return structured error for network/timeout failures.
    const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
    const isTimeout = lastError instanceof Error && lastError.name === "AbortError";
    const extractorError: ExtractorError = {
      type: isTimeout ? "timeout" : "network_error",
      message: errorMessage,
      retryable: true,
    };

    return { candidates: [], rawResponse: lastError, error: extractorError };
  }
}

