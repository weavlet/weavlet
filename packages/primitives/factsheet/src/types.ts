import type { ZodIssue, ZodObject, ZodRawShape, ZodTypeAny } from "zod";
import type { StorageAdapter } from "./storage/types";

export type SourcePriorityMap = Record<string, number>;

export interface Provenance {
  value: unknown;
  source: string;
  timestamp: number; // server-assigned Unix ms
  confidence: number; // 0-1
  inferred: boolean;
}

export interface HistoryEntry {
  field: string;
  value: unknown;
  previousValue?: unknown;
  source: string;
  timestamp: number;
  confidence: number;
  inferred: boolean;
  action: "set" | "delete" | "rejected";
  reason?: string;
}

/**
 * Configuration for validating and sanitizing the `extras` field.
 * All properties are optional; defaults are applied internally.
 */
export interface ExtrasPolicy {
  /**
   * Regular expression for validating extra keys.
   * @default /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/  (allows uppercase)
   */
  keyPattern?: RegExp;
  /**
   * Maximum length of each key string.
   * @default 64
   */
  maxKeyLength?: number;
  /**
   * Maximum length of string values. Longer strings are truncated.
   * @default 512
   */
  maxStringLength?: number;
  /**
   * Whether to allow array values in extras.
   * If false, arrays are silently dropped.
   * @default false
   */
  allowArrays?: boolean;
  /**
   * Whether to allow nested object values in extras.
   * If false, nested objects are silently dropped.
   * @default false
   */
  allowNestedObjects?: boolean;
  /**
   * Maximum depth for nested objects (only applies if allowNestedObjects is true).
   * @default 2
   */
  maxNestingDepth?: number;
  /**
   * Maximum number of items allowed in an array (only applies if allowArrays is true).
   * @default 32
   */
  maxArrayLength?: number;
}

export interface ConflictPolicy {
  sourcePriority: SourcePriorityMap;
  minConfidence: number;
  recencyWindowMs: number;
  maxFieldLength: number;
  extrasMaxKeys: number;
  /**
   * Policy for validating and sanitizing the `extras` field.
   * If not provided, sensible defaults are used.
   */
  extrasPolicy?: ExtrasPolicy;
}

export interface ExtractorCandidate {
  field: string;
  value: unknown;
  confidence: number;
  inferred: boolean;
  // Optional server-side timestamp for ordering/recency checks; defaults to now.
  timestamp?: number;
  source?: string;
}

/**
 * Structured error from the extractor when the API returns a non-2xx response
 * or when parsing fails in a recoverable way.
 */
export interface ExtractorError {
  type: "api_error" | "parse_error" | "timeout" | "network_error";
  /** HTTP status code (for api_error type) */
  status?: number;
  /** HTTP status text (for api_error type) */
  statusText?: string;
  /** Response body or error message */
  message: string;
  /** Whether the error is retryable */
  retryable: boolean;
}

export interface ExtractorResult {
  candidates: ExtractorCandidate[];
  rawResponse?: unknown;
  latencyMs?: number;
  /** Populated when an error occurs during extraction */
  error?: ExtractorError;
}

/**
 * Context passed to custom extractors, exposing all relevant
 * configuration for replicating built-in extractor behavior.
 */
export interface ExtractorContext {
  /** Which source the text was extracted from: input, output, or both */
  extractFrom: "input" | "output" | "both";
  /** Maximum input characters (after sanitization) */
  maxInputChars: number;
  /** Timeout in milliseconds for the extraction call */
  timeoutMs: number;
  /** Number of retry attempts on failure */
  retries: number;
  /** Error handling strategy: skip (return empty) or throw */
  onError: "skip" | "throw";
  /** The raw (unsanitized) input text */
  rawInput: string;
  /** The raw (unsanitized) output text, if provided */
  rawOutput?: string;
}

export type CustomExtractor = (
  input: string,
  output: string | undefined,
  schema: ZodObject<ZodRawShape>,
  context: ExtractorContext
) => Promise<ExtractorResult>;

export interface ExtractorConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
  extractFrom?: "input" | "output" | "both";
  // Character-based limiter (preferred). Falls back to maxInputTokens for back-compat.
  maxInputChars?: number;
  maxInputTokens?: number;
  timeoutMs?: number;
  retries?: number;
  onError?: "skip" | "throw";
  custom?: CustomExtractor;
}

export interface ObserveRequest {
  userId: string;
  input: string;
  output?: string;
  source?: string;
  confidence?: number;
  idempotencyKey?: string;
  mode?: "sync" | "async";
  extractFrom?: "input" | "output" | "both";
}

export interface PatchRequest<TFacts extends Record<string, unknown> = Record<string, unknown>> {
  userId: string;
  facts: Partial<TFacts>;
  source?: string;
  confidence?: number;
  idempotencyKey?: string;
}

export type RejectionReason =
  | "schema_invalid"
  | "unknown_field"
  | "low_confidence"
  | "lower_priority"
  | "outside_recency"
  | "older_timestamp"
  | "not_nullable"
  | "extras_invalid";

export interface RejectedField {
  field: string;
  value: unknown;
  reason: RejectionReason;
  /** Detailed Zod validation issues for nested/complex schema errors. */
  details?: ZodIssue[];
}

export interface ObserveResult<TFacts extends Record<string, unknown> = Record<string, unknown>> {
  profile: TFacts;
  updated: Partial<TFacts>;
  rejected: RejectedField[];
  extracted: Partial<TFacts>;
  rawResponse?: unknown;
  queued?: boolean;
  latencyMs?: number;
  requestId?: string;
}

export interface PatchResult<TFacts extends Record<string, unknown> = Record<string, unknown>> {
  profile: TFacts;
  updated: Partial<TFacts>;
  rejected: RejectedField[];
}

export interface FactSheetConfig<TSchema extends ZodObject<ZodRawShape>> {
  storage: StorageAdapter;
  extractor?: ExtractorConfig;
  policy?: Partial<ConflictPolicy>;
  schema?: TSchema;
  logger?: (message: string, meta?: Record<string, unknown>) => void;
}

export type FactSheetEvents<TFacts extends Record<string, unknown>> = {
  update: {
    userId: string;
    updated: Partial<TFacts>;
    profile: TFacts;
  };
  conflict: {
    userId: string;
    rejected: RejectedField[];
  };
  observe_complete: {
    userId: string;
    requestId: string;
    result?: ObserveResult<TFacts>;
    error?: unknown;
  };
};

export type SchemaType<TSchema extends ZodTypeAny> = ZodObject<ZodRawShape> & {
  _type: Record<string, unknown>;
};

