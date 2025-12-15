import { z, type ZodObject, type ZodRawShape } from "zod";
import { mergeCandidates } from "./conflict";
import { Extractor } from "./extractor";
import { EventEmitter } from "./events";
import {
  ConflictPolicy,
  FactSheetConfig,
  FactSheetEvents,
  ObserveRequest,
  ObserveResult,
  PatchRequest,
  PatchResult,
  ExtractorCandidate,
  RejectedField,
} from "./types";
import type { StorageAdapter, StorageRecord } from "./storage/types";
import { allowsNull, cleanControlChars } from "./utils";
import { ConcurrencyError, SchemaNotRegisteredError, ExtractorNotConfiguredError, ValidationError, PersistenceError } from "./errors";

const DEFAULT_POLICY: ConflictPolicy = {
  sourcePriority: { crm: 3, manual: 2, observe: 1, inferred: 0 },
  minConfidence: 0.35,
  recencyWindowMs: 24 * 60 * 60 * 1000,
  maxFieldLength: 1024,
  extrasMaxKeys: 32,
};

type InferFacts<TSchema extends ZodObject<ZodRawShape>> = z.infer<TSchema>;

/**
 * Recursively normalizes enum values for case-insensitive matching.
 * Handles nested objects, arrays, optionals, nullables, and unions.
 */
const normalizeEnumValue = (schema: any, value: unknown): unknown => {
  if (value === null || value === undefined) return value;

  const typeName = schema?._def?.typeName;

  // Handle ZodEnum
  if (typeName === "ZodEnum") {
    if (typeof value !== "string") return value;
    const options: string[] = schema._def.values;
    const lower = value.toLowerCase();
    const match = options.find((opt) => opt.toLowerCase() === lower);
    return match ?? value;
  }

  // Handle ZodNativeEnum
  if (typeName === "ZodNativeEnum") {
    if (typeof value !== "string") return value;
    const options = Object.values(schema._def.values).filter((v) => typeof v === "string") as string[];
    const lower = value.toLowerCase();
    const match = options.find((opt) => opt.toLowerCase() === lower);
    return match ?? value;
  }

  // Handle ZodOptional and ZodNullable - unwrap and recurse
  if (typeName === "ZodOptional" || typeName === "ZodNullable") {
    return normalizeEnumValue(schema._def.innerType, value);
  }

  // Handle ZodDefault - unwrap and recurse
  if (typeName === "ZodDefault") {
    return normalizeEnumValue(schema._def.innerType, value);
  }

  // Handle ZodEffects (refine, transform, etc.) - unwrap and recurse
  if (typeName === "ZodEffects") {
    return normalizeEnumValue(schema._def.schema, value);
  }

  // Handle ZodUnion - try each option until one matches
  if (typeName === "ZodUnion") {
    const options = schema._def.options;
    for (const option of options) {
      const normalized = normalizeEnumValue(option, value);
      // If normalized value differs, an enum match was found
      if (normalized !== value) return normalized;
    }
    return value;
  }

  // Handle ZodArray - normalize each element
  if (typeName === "ZodArray") {
    if (!Array.isArray(value)) return value;
    const elementSchema = schema._def.type;
    return value.map((item) => normalizeEnumValue(elementSchema, item));
  }

  // Handle ZodObject - recursively normalize each field
  if (typeName === "ZodObject") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const shape = schema.shape;
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const fieldSchema = shape[key];
      if (fieldSchema) {
        result[key] = normalizeEnumValue(fieldSchema, val);
      } else {
        // Preserve unknown fields as-is
        result[key] = val;
      }
    }
    return result;
  }

  return value;
};

/**
 * FactSheet maintains a live, structured profile for each user by extracting
 * facts from conversations and resolving conflicts deterministically.
 *
 * @template TSchema - A Zod object schema defining the profile structure
 *
 * @example
 * ```typescript
 * const factSheet = new FactSheet({
 *   storage: new MemoryAdapter(),
 *   schema: z.object({ name: z.string().optional() }),
 *   extractor: { baseURL: '...', apiKey: '...', model: 'gpt-4o-mini' },
 * });
 * ```
 */
export class FactSheet<TSchema extends ZodObject<ZodRawShape>> {
  private schemaDef?: TSchema;
  private extractor?: Extractor;
  private readonly storage: StorageAdapter;
  private readonly policy: ConflictPolicy;
  private readonly events = new EventEmitter<FactSheetEvents<InferFacts<TSchema>>>();
  private readonly logger?: (message: string, meta?: Record<string, unknown>) => void;
  private readonly idempotencyCache = new Map<
    string,
    {
      value: ObserveResult<InferFacts<TSchema>> | PatchResult<InferFacts<TSchema>>;
      expiresAt: number;
    }
  >();
  private static readonly IDEMPOTENCY_CACHE_LIMIT = 1000;
  private static readonly IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Creates a new FactSheet instance.
   *
   * @param config - Configuration options
   * @param config.storage - Storage adapter for persisting profiles (required)
   * @param config.schema - Zod schema defining valid fields (optional, can be set later via schema())
   * @param config.extractor - LLM configuration for extraction (required for observe())
   * @param config.policy - Conflict resolution policy (optional)
   * @param config.logger - Custom logging function (optional)
   */
  constructor(config: FactSheetConfig<TSchema>) {
    this.storage = config.storage;
    this.policy = { ...DEFAULT_POLICY, ...(config.policy ?? {}) };
    this.logger = config.logger;

    if (config.extractor) {
      this.extractor = new Extractor(config.extractor);
    }

    if (config.schema) {
      this.schema(config.schema);
    }
  }

  /**
   * Registers or updates the schema for this FactSheet.
   *
   * @param schema - A Zod object schema defining valid profile fields
   * @throws {ValidationError} If the schema is not a ZodObject
   *
   * @example
   * ```typescript
   * factSheet.schema(z.object({
   *   name: z.string().optional(),
   *   role: z.enum(['founder', 'engineer']).optional(),
   * }));
   * ```
   */
  schema(schema: TSchema): void {
    if (schema._def.typeName !== "ZodObject") {
      throw new ValidationError("FactSheet schema must be a Zod object", undefined, { typeName: schema._def.typeName });
    }
    this.schemaDef = schema;
  }

  /**
   * Subscribes to FactSheet events.
   *
   * @param event - Event name: 'update', 'conflict', or 'observe_complete'
   * @param handler - Callback function invoked when the event fires
   * @returns Unsubscribe function
   *
   * @example
   * ```typescript
   * const unsubscribe = factSheet.on('update', ({ userId, updated }) => {
   *   console.log(`User ${userId} updated:`, updated);
   * });
   * // Later: unsubscribe();
   * ```
   */
  on<K extends keyof FactSheetEvents<InferFacts<TSchema>>>(
    event: K,
    handler: (payload: FactSheetEvents<InferFacts<TSchema>>[K]) => void
  ): () => void {
    return this.events.on(event, handler as any);
  }

  /**
   * Extracts facts from user input (and optionally AI output) using the configured LLM,
   * then merges them into the user's profile with conflict resolution.
   *
   * @param request - Observation request parameters
   * @param request.userId - Unique user identifier
   * @param request.input - User's input text to extract facts from
   * @param request.output - AI response text (optional, for extractFrom: 'output' or 'both')
   * @param request.source - Source identifier for conflict resolution (default: 'observe')
   * @param request.confidence - Confidence level 0-1 (default: 0.8)
   * @param request.extractFrom - Which text to extract from: 'input', 'output', or 'both'
   * @param request.idempotencyKey - Optional key to prevent duplicate processing
   * @param request.mode - 'sync' (default) or 'async' for background processing
   * @returns Observation result with profile, updated fields, rejections, and extraction data
   * @throws {SchemaNotRegisteredError} If no schema has been registered
   * @throws {ExtractorNotConfiguredError} If no extractor is configured
   *
   * @example
   * ```typescript
   * const result = await factSheet.observe({
   *   userId: 'user_123',
   *   input: "I'm Alice, CTO at Acme.",
   *   output: "Nice to meet you, Alice!",
   *   extractFrom: 'both',
   * });
   * ```
   */
  async observe(request: ObserveRequest): Promise<ObserveResult<InferFacts<TSchema>>> {
    if (!this.schemaDef) throw new SchemaNotRegisteredError();
    if (!this.extractor) throw new ExtractorNotConfiguredError();

    const idKey = request.idempotencyKey
      ? this.makeIdempotencyKey("observe", request.userId, request.idempotencyKey)
      : null;
    const requestId = this.makeRequestId();

    if (idKey) {
      const cached = this.getIdempotencyCache(idKey);
      if (cached !== undefined) {
        return cached as ObserveResult<InferFacts<TSchema>>;
      }
    }

    if (request.mode === "async") {
      // Read profile BEFORE firing background task to ensure a consistent snapshot.
      // This prevents a race condition where the returned profile could be stale or
      // different from what processObserve operates on.
      const existing = await this.storage.get(request.userId);
      const snapshotProfile = (existing?.profile ?? {}) as InferFacts<TSchema>;

      void this.processObserve(request, idKey, requestId)
        .then((result) =>
          this.events.emit("observe_complete", { userId: request.userId, requestId, result })
        )
        .catch((err) => {
          this.logError("observe_async_failed", err);
          this.events.emit("observe_complete", { userId: request.userId, requestId, error: err });
        });

      return {
        profile: snapshotProfile,
        updated: {},
        rejected: [],
        extracted: {},
        rawResponse: undefined,
        queued: true,
        requestId,
      };
    }

    return this.processObserve(request, idKey, requestId);
  }

  private async processObserve(
    request: ObserveRequest,
    idKey?: string | null,
    requestId?: string
  ): Promise<ObserveResult<InferFacts<TSchema>>> {
    const schema = this.ensureSchema();
    const extraction = await this.extractor!.extract(
      cleanControlChars(request.input),
      request.output ? cleanControlChars(request.output) : undefined,
      schema,
      request.extractFrom
    );

    const { accepted, rejected, extracted } = this.validateCandidates(
      extraction.candidates,
      request
    );

    const merged = await this.mergeAndPersistWithRetry({
      userId: request.userId,
      candidates: accepted,
      skipRecencyCheck: false,
    });

    if (Object.keys(merged.updated).length > 0) {
      this.events.emit("update", {
        userId: request.userId,
        updated: merged.updated as Partial<InferFacts<TSchema>>,
        profile: merged.profile as InferFacts<TSchema>,
      });
    }

    if (merged.rejected.length > 0 || rejected.length > 0) {
      this.events.emit("conflict", {
        userId: request.userId,
        rejected: [...rejected, ...merged.rejected],
      });
    }

    const result: ObserveResult<InferFacts<TSchema>> = {
      profile: merged.profile as InferFacts<TSchema>,
      updated: merged.updated as Partial<InferFacts<TSchema>>,
      rejected: [...rejected, ...merged.rejected],
      extracted: extracted as Partial<InferFacts<TSchema>>,
      rawResponse: extraction.rawResponse,
      latencyMs: extraction.latencyMs,
      requestId,
    };

    if (idKey) {
      this.setIdempotencyCache(idKey, result);
    }

    return result;
  }

  /**
   * Manually sets facts from trusted sources (CRM, user forms, admin).
   * Unlike observe(), patch() does not use LLM extraction.
   *
   * @param request - Patch request parameters
   * @param request.userId - Unique user identifier
   * @param request.facts - Partial profile with fields to set
   * @param request.source - Source identifier for conflict resolution (default: 'manual')
   * @param request.confidence - Confidence level 0-1 (default: 1.0)
   * @param request.idempotencyKey - Optional key to prevent duplicate processing
   * @returns Patch result with updated profile, changed fields, and rejections
   * @throws {SchemaNotRegisteredError} If no schema has been registered
   *
   * @example
   * ```typescript
   * const result = await factSheet.patch({
   *   userId: 'user_123',
   *   facts: { company: 'Acme Corp', budget: 'high' },
   *   source: 'crm',
   * });
   * ```
   */
  async patch(request: PatchRequest<InferFacts<TSchema>>): Promise<PatchResult<InferFacts<TSchema>>> {
    const schema = this.ensureSchema();

    const idKey = request.idempotencyKey
      ? this.makeIdempotencyKey("patch", request.userId, request.idempotencyKey)
      : null;
    if (idKey) {
      const cached = this.getIdempotencyCache(idKey);
      if (cached !== undefined) {
        return cached as PatchResult<InferFacts<TSchema>>;
      }
    }

    const fields = Object.keys(request.facts ?? {});
    const rejected: RejectedField[] = [];
    const accepted: Array<ExtractorCandidate & { source: string }> = [];

    const shape = schema.shape;

    for (const field of fields) {
      const value = (request.facts as any)[field];
      const fieldSchema = (shape as any)[field];
      if (!fieldSchema) {
        rejected.push({ field, value, reason: "unknown_field" });
        continue;
      }

      const sanitizedValue =
        field === "extras" ? this.sanitizeExtrasValue(value, this.policy) : value;
      if (field === "extras" && sanitizedValue === undefined) {
        rejected.push({ field, value, reason: "extras_invalid" });
        continue;
      }

      const normalizedValue = normalizeEnumValue(fieldSchema, sanitizedValue);
      const parsed = fieldSchema.safeParse(normalizedValue);
      if (!parsed.success) {
        rejected.push({
          field,
          value,
          reason: "schema_invalid",
          details: parsed.error.issues,
        });
        continue;
      }

      accepted.push({
        field,
        value: parsed.data,
        confidence: request.confidence ?? 1,
        inferred: false,
        source: request.source ?? "manual",
      });
    }

    const merged = await this.mergeAndPersistWithRetry({
      userId: request.userId,
      candidates: accepted,
      skipRecencyCheck: true,
    });

    if (Object.keys(merged.updated).length > 0) {
      this.events.emit("update", {
        userId: request.userId,
        updated: merged.updated as Partial<InferFacts<TSchema>>,
        profile: merged.profile as InferFacts<TSchema>,
      });
    }

    if (merged.rejected.length > 0 || rejected.length > 0) {
      this.events.emit("conflict", {
        userId: request.userId,
        rejected: [...rejected, ...merged.rejected],
      });
    }

    const result: PatchResult<InferFacts<TSchema>> = {
      profile: merged.profile as InferFacts<TSchema>,
      updated: merged.updated as Partial<InferFacts<TSchema>>,
      rejected: [...rejected, ...merged.rejected],
    };

    if (idKey) {
      this.setIdempotencyCache(idKey, result);
    }

    return result;
  }

  /**
   * Retrieves the current profile for a user.
   *
   * @param userId - Unique user identifier
   * @returns The user's profile, or null if no profile exists
   * @throws {SchemaNotRegisteredError} If no schema has been registered
   *
   * @example
   * ```typescript
   * const profile = await factSheet.get('user_123');
   * if (profile) {
   *   console.log(profile.name);
   * }
   * ```
   */
  async get(userId: string): Promise<InferFacts<TSchema> | null> {
    this.ensureSchema();
    const record = await this.storage.get(userId);
    if (!record) return null;
    return record.profile as InferFacts<TSchema>;
  }

  /**
   * Queries the change history for a user's profile.
   *
   * @param userId - Unique user identifier
   * @param options - Query options
   * @param options.field - Filter history to a specific field
   * @param options.cursor - Pagination cursor from previous result's nextCursor
   * @param options.limit - Maximum entries to return (default: 50)
   * @returns History entries and optional nextCursor for pagination
   * @throws {SchemaNotRegisteredError} If no schema has been registered
   *
   * @remarks
   * Cursor format varies by adapter:
   * - MemoryAdapter: Unix timestamp (ms)
   * - PostgresAdapter: Record ID (BIGSERIAL)
   * - RedisAdapter: Sorted set score (timestamp)
   *
   * Treat cursors as opaque strings—pass them back without parsing.
   *
   * @example
   * ```typescript
   * const { entries, nextCursor } = await factSheet.history('user_123', {
   *   field: 'name',
   *   limit: 10,
   * });
   * ```
   */
  async history(userId: string, options?: { field?: string; cursor?: string; limit?: number }) {
    this.ensureSchema();
    return this.storage.getHistory(userId, options);
  }

  /**
   * Returns non-undefined fields as a filter object, useful for database queries.
   *
   * @param userId - Unique user identifier
   * @param options - Filter options
   * @param options.select - Array of field names to include (omit for all fields)
   * @returns Object with non-undefined profile fields, or empty object if user not found
   *
   * @example
   * ```typescript
   * const filters = await factSheet.filters('user_123', {
   *   select: ['role', 'budget'],
   * });
   * // Use in database query: WHERE role = filters.role AND budget = filters.budget
   * ```
   */
  async filters(userId: string, options?: { select?: Array<keyof InferFacts<TSchema>> }) {
    const profile = await this.get(userId);
    if (!profile) return {};
    const selectSet = options?.select ? new Set(options.select as string[]) : null;
    const filters: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(profile)) {
      if (selectSet && !selectSet.has(key)) continue;
      if (value === undefined) continue;
      filters[key] = value;
    }
    return filters;
  }

  /**
   * Returns the user's profile as a compact JSON string for LLM system prompts.
   * Keys are sorted alphabetically for consistent prompt caching.
   *
   * @param userId - Unique user identifier
   * @param options - Formatting options
   * @param options.select - Array of field names to include (omit for all fields)
   * @param options.includeNulls - Whether to include null values (default: false)
   * @returns Compact JSON string, or null if user not found
   *
   * @example
   * ```typescript
   * const facts = await factSheet.factsForPrompt('user_123');
   * // → '{"intent":"migrate","name":"Alice","role":"founder"}'
   *
   * const systemPrompt = `You are helping a user. Known facts: ${facts ?? '{}'}`;
   * ```
   */
  async factsForPrompt(
    userId: string,
    options?: { select?: Array<keyof InferFacts<TSchema>>; includeNulls?: boolean }
  ): Promise<string | null> {
    const profile = await this.get(userId);
    if (!profile) return null;
    const selectSet = options?.select ? new Set(options.select as string[]) : null;
    const includeNulls = options?.includeNulls ?? false;
    const orderedKeys = Object.keys(profile)
      .filter((k) => !selectSet || selectSet.has(k))
      .sort();
    const compact: Record<string, unknown> = {};
    for (const key of orderedKeys) {
      const value = (profile as any)[key];
      if (value === undefined) continue;
      if (value === null && !includeNulls) continue;
      compact[key] = value;
    }
    return JSON.stringify(compact);
  }

  private ensureSchema(): TSchema {
    if (!this.schemaDef) throw new SchemaNotRegisteredError();
    return this.schemaDef;
  }

  private allowsNull(field: string): boolean {
    const schema = this.ensureSchema();
    const shape = schema.shape as Record<string, any>;
    const fieldSchema = shape[field];
    if (!fieldSchema) return false;
    return allowsNull(fieldSchema);
  }

  private validateCandidates(
    candidates: ExtractorCandidate[],
    request: ObserveRequest
  ): {
    accepted: Array<ExtractorCandidate & { source: string }>;
    rejected: RejectedField[];
    extracted: Record<string, unknown>;
  } {
    const schema = this.ensureSchema();
    const shape = schema.shape as Record<string, any>;
    const accepted: Array<ExtractorCandidate & { source: string }> = [];
    const rejected: RejectedField[] = [];
    const extracted: Record<string, unknown> = {};

    for (const candidate of candidates) {
      const fieldSchema = shape[candidate.field];
      if (!fieldSchema) {
        rejected.push({ field: candidate.field, value: candidate.value, reason: "unknown_field" });
        continue;
      }

      const sanitizedValue =
        candidate.field === "extras"
          ? this.sanitizeExtrasValue(candidate.value, this.policy)
          : candidate.value;

      if (candidate.field === "extras" && sanitizedValue === undefined) {
        rejected.push({ field: candidate.field, value: candidate.value, reason: "extras_invalid" });
        continue;
      }

      const normalizedValue = normalizeEnumValue(fieldSchema, sanitizedValue);
      const parsed = fieldSchema.safeParse(normalizedValue);
      if (!parsed.success) {
        rejected.push({
          field: candidate.field,
          value: candidate.value,
          reason: "schema_invalid",
          details: parsed.error.issues,
        });
        continue;
      }

      extracted[candidate.field] = sanitizedValue;
      accepted.push({
        ...candidate,
        value: parsed.data,
        source: candidate.source ?? (candidate.inferred ? "inferred" : request.source ?? "observe"),
        confidence: candidate.confidence ?? request.confidence ?? 0.8,
      });
    }

    return { accepted, rejected, extracted };
  }

  private async persist(
    userId: string,
    profile: Record<string, unknown>,
    provenance: Record<string, any>,
    history: any[],
    existing: StorageRecord
  ) {
    await this.storage.set(userId, profile, provenance, { etag: existing.etag }, history);
  }

  private defaultRecord(): StorageRecord {
    return { profile: {}, provenance: {}, etag: "0" };
  }

  private async mergeAndPersistWithRetry(params: {
    userId: string;
    candidates: Array<ExtractorCandidate & { source: string }>;
    skipRecencyCheck: boolean;
  }) {
    const { userId, candidates, skipRecencyCheck } = params;
    let existing = (await this.storage.get(userId)) ?? this.defaultRecord();
    let attempts = 0;
    let lastError: Error | undefined;

    while (attempts < 2) {
      const merged = mergeCandidates({
        profile: existing.profile,
        provenance: existing.provenance,
        candidates,
        policy: this.policy,
        allowNull: (field) => this.allowsNull(field),
        skipRecencyCheck,
      });

      try {
        await this.persist(userId, merged.profile, merged.provenance, merged.history, existing);
        return merged;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (err instanceof ConcurrencyError && attempts === 0) {
          existing = (await this.storage.get(userId)) ?? this.defaultRecord();
          attempts += 1;
          continue;
        }
        throw err;
      }
    }

    throw new PersistenceError(
      `Failed to persist after ${attempts} retry attempt(s)`,
      attempts,
      lastError
    );
  }

  /**
   * Sanitizes the `extras` field value according to the configured ExtrasPolicy.
   * Returns null if value is null, undefined if invalid or empty after sanitization.
   */
  private sanitizeExtrasValue(value: unknown, policy: ConflictPolicy): Record<string, unknown> | null | undefined {
    if (value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

    const extrasPolicy = policy.extrasPolicy ?? {};
    const keyLimit = policy.extrasMaxKeys;
    // Default regex now allows uppercase letters (was the main complaint)
    const keyRegex = extrasPolicy.keyPattern ?? /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/;
    const maxKeyLength = extrasPolicy.maxKeyLength ?? 64;
    const maxStringLength = Math.min(extrasPolicy.maxStringLength ?? 512, policy.maxFieldLength);
    const allowArrays = extrasPolicy.allowArrays ?? false;
    const allowNestedObjects = extrasPolicy.allowNestedObjects ?? false;
    const maxNestingDepth = extrasPolicy.maxNestingDepth ?? 2;
    const maxArrayLength = extrasPolicy.maxArrayLength ?? 32;

    const sanitizeValue = (raw: unknown, depth: number): unknown | undefined => {
      if (raw === null) return null;

      if (typeof raw === "string") {
        return raw.length > maxStringLength ? raw.slice(0, maxStringLength) : raw;
      }

      if (typeof raw === "number") {
        return Number.isFinite(raw) ? raw : undefined;
      }

      if (typeof raw === "boolean") {
        return raw;
      }

      if (Array.isArray(raw)) {
        if (!allowArrays) return undefined;
        const sanitizedArray: unknown[] = [];
        for (const item of raw.slice(0, maxArrayLength)) {
          const sanitized = sanitizeValue(item, depth);
          if (sanitized !== undefined) {
            sanitizedArray.push(sanitized);
          }
        }
        return sanitizedArray.length > 0 ? sanitizedArray : undefined;
      }

      if (typeof raw === "object") {
        if (!allowNestedObjects) return undefined;
        if (depth >= maxNestingDepth) return undefined;
        const nested = raw as Record<string, unknown>;
        const sanitizedNested: Record<string, unknown> = {};
        for (const [nestedKey, nestedValue] of Object.entries(nested)) {
          if (typeof nestedKey !== "string") continue;
          if (nestedKey.length > maxKeyLength) continue;
          // Nested keys use the same pattern validation
          if (!keyRegex.test(nestedKey)) continue;
          const sanitized = sanitizeValue(nestedValue, depth + 1);
          if (sanitized !== undefined) {
            sanitizedNested[nestedKey] = sanitized;
          }
        }
        return Object.keys(sanitizedNested).length > 0 ? sanitizedNested : undefined;
      }

      return undefined;
    };

    const entries = Object.entries(value as Record<string, unknown>);
    const sanitized: Record<string, unknown> = {};

    for (const [key, raw] of entries) {
      if (Object.keys(sanitized).length >= keyLimit) break;
      if (typeof key !== "string") continue;
      if (key.length > maxKeyLength) continue;
      if (!keyRegex.test(key)) continue;

      const sanitizedValue = sanitizeValue(raw, 0);
      if (sanitizedValue !== undefined) {
        sanitized[key] = sanitizedValue;
      }
    }

    if (Object.keys(sanitized).length === 0) {
      return undefined;
    }

    return sanitized;
  }

  private makeIdempotencyKey(kind: "observe" | "patch", userId: string, key: string) {
    return `${kind}:${userId}:${key}`;
  }

  private makeRequestId() {
    const globalCrypto = (globalThis as any)?.crypto;
    if (globalCrypto?.randomUUID) {
      return globalCrypto.randomUUID();
    }
    return `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  private getIdempotencyCache(
    key: string
  ): ObserveResult<InferFacts<TSchema>> | PatchResult<InferFacts<TSchema>> | undefined {
    const entry = this.idempotencyCache.get(key);
    if (!entry) return undefined;

    // Check if the entry has expired
    if (Date.now() > entry.expiresAt) {
      this.idempotencyCache.delete(key);
      return undefined;
    }

    return entry.value;
  }

  private setIdempotencyCache(
    key: string,
    value: ObserveResult<InferFacts<TSchema>> | PatchResult<InferFacts<TSchema>>
  ) {
    const now = Date.now();

    // Prune expired entries to avoid unbounded growth from stale keys
    for (const [k, entry] of this.idempotencyCache) {
      if (now > entry.expiresAt) {
        this.idempotencyCache.delete(k);
      }
    }

    // Evict oldest entry if still at capacity (size-bound fallback)
    if (this.idempotencyCache.size >= FactSheet.IDEMPOTENCY_CACHE_LIMIT) {
      const firstKey = this.idempotencyCache.keys().next().value;
      if (firstKey) this.idempotencyCache.delete(firstKey);
    }

    this.idempotencyCache.set(key, {
      value,
      expiresAt: now + FactSheet.IDEMPOTENCY_TTL_MS,
    });
  }

  private logError(message: string, error?: unknown) {
    if (this.logger) {
      const errorInfo: Record<string, unknown> = {};
      if (error instanceof Error) {
        errorInfo.message = error.message;
        errorInfo.name = error.name;
        errorInfo.stack = error.stack;
        // Preserve any additional properties on custom error types
        for (const key of Object.keys(error)) {
          if (!(key in errorInfo)) {
            errorInfo[key] = (error as unknown as Record<string, unknown>)[key];
          }
        }
      } else if (error !== undefined) {
        errorInfo.value = error;
      }
      this.logger(message, { error: errorInfo });
    }
  }
}

