import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FactSheet } from "../factsheet";
import { MemoryAdapter } from "../adapters/memory";

const ProfileSchema = z.object({
  name: z.string(),
  role: z.enum(["founder", "engineer"]).optional(),
  churn_risk: z.enum(["low", "medium", "high"]).nullable().optional(),
});

describe("FactSheet", () => {
  it("applies custom extractor candidates on observe", async () => {
    const factSheet = new FactSheet({
      storage: new MemoryAdapter(),
      extractor: {
        baseURL: "http://localhost",
        apiKey: "test",
        model: "test-model",
        custom: async () => ({
          candidates: [{ field: "role", value: "engineer", confidence: 0.9, inferred: true }],
        }),
      },
      schema: ProfileSchema,
    });

    const result = await factSheet.observe({ userId: "u1", input: "hello", mode: "sync" });
    expect(result.profile.role).toBe("engineer");
    expect(result.updated.role).toBe("engineer");
  });

  it("allows nullable deletes via patch", async () => {
    const factSheet = new FactSheet({
      storage: new MemoryAdapter(),
      extractor: {
        baseURL: "http://localhost",
        apiKey: "test",
        model: "test-model",
        custom: async () => ({ candidates: [] }),
      },
      schema: ProfileSchema,
    });

    await factSheet.patch({
      userId: "u1",
      facts: { name: "Ada", churn_risk: "high" },
      source: "manual",
    });

    const patched = await factSheet.patch({
      userId: "u1",
      facts: { churn_risk: null },
      source: "manual",
    });

    expect(patched.profile.churn_risk).toBeNull();
    expect(patched.updated.churn_risk).toBeNull();
  });

  it("dedupes patch calls with idempotencyKey", async () => {
    const adapter = new MemoryAdapter();
    const factSheet = new FactSheet({
      storage: adapter,
      schema: ProfileSchema,
    });

    const first = await factSheet.patch({
      userId: "u1",
      facts: { name: "Ada" },
      source: "manual",
      idempotencyKey: "k1",
    });
    expect(first.profile.name).toBe("Ada");

    const second = await factSheet.patch({
      userId: "u1",
      facts: { name: "Ada" },
      source: "manual",
      idempotencyKey: "k1",
    });

    expect(second.profile.name).toBe("Ada");
    const stored = await adapter.get("u1");
    expect(stored?.etag).toBe("1"); // no second write
  });

  it("enforces extras constraints", async () => {
    const factSheet = new FactSheet({
      storage: new MemoryAdapter(),
      schema: z.object({
        name: z.string(),
        extras: z.record(z.string()).optional(),
      }),
    });

    // Keys with special characters (-, @) are rejected
    const invalid = await factSheet.patch({
      userId: "u2",
      facts: { name: "Bob", extras: { "invalid-key@test": "x" } },
      source: "manual",
    });
    expect(invalid.rejected[0]?.field).toBe("extras");
    expect(invalid.rejected[0]?.reason).toBe("extras_invalid");

    // Uppercase is now allowed by default (changed behavior)
    const withUppercase = await factSheet.patch({
      userId: "u2",
      facts: { name: "Bob", extras: { UpperCaseKey: "value" } },
      source: "manual",
    });
    expect(withUppercase.rejected.length).toBe(0);
    expect((withUppercase.profile as any).extras["UpperCaseKey"]).toBe("value");

    // String truncation still works
    const valid = await factSheet.patch({
      userId: "u2",
      facts: { name: "Bob", extras: { "support.ticket.priority": "p".repeat(600) } },
      source: "manual",
    });

    expect(valid.rejected.length).toBe(0);
    expect((valid.profile as any).extras["support.ticket.priority"]).toHaveLength(512);
  });

  it("respects configurable ExtrasPolicy", async () => {
    // Test with custom lowercase-only regex (opt-in strict mode)
    const strictFactSheet = new FactSheet({
      storage: new MemoryAdapter(),
      schema: z.object({
        name: z.string(),
        extras: z.record(z.unknown()).optional(),
      }),
      policy: {
        extrasPolicy: {
          keyPattern: /^[a-z0-9_]+$/, // Lowercase only
          allowArrays: true,
          allowNestedObjects: true,
          maxNestingDepth: 2,
          maxArrayLength: 3,
        },
      },
    });

    // Uppercase rejected with strict pattern
    const uppercaseRejected = await strictFactSheet.patch({
      userId: "config-test",
      facts: { name: "Test", extras: { UpperCase: "value" } },
      source: "manual",
    });
    expect(uppercaseRejected.rejected[0]?.field).toBe("extras");

    // Lowercase accepted
    const lowercaseAccepted = await strictFactSheet.patch({
      userId: "config-test",
      facts: { name: "Test", extras: { lowercase_key: "value" } },
      source: "manual",
    });
    expect(lowercaseAccepted.rejected.length).toBe(0);
    expect((lowercaseAccepted.profile as any).extras["lowercase_key"]).toBe("value");

    // Arrays allowed when configured
    const withArray = await strictFactSheet.patch({
      userId: "config-test2",
      facts: { name: "Test", extras: { tags: ["a", "b", "c", "d", "e"] } },
      source: "manual",
    });
    expect(withArray.rejected.length).toBe(0);
    // Truncated to maxArrayLength=3
    expect((withArray.profile as any).extras["tags"]).toEqual(["a", "b", "c"]);

    // Nested objects allowed when configured
    const withNested = await strictFactSheet.patch({
      userId: "config-test3",
      facts: { name: "Test", extras: { meta: { level1: { level2: "deep" } } } },
      source: "manual",
    });
    expect(withNested.rejected.length).toBe(0);
    expect((withNested.profile as any).extras["meta"]["level1"]["level2"]).toBe("deep");
  });

  it("marks inferred candidates with inferred source", async () => {
    const adapter = new MemoryAdapter();
    const factSheet = new FactSheet({
      storage: adapter,
      extractor: {
        baseURL: "http://localhost",
        apiKey: "test",
        model: "test-model",
        custom: async () => ({
          candidates: [{ field: "role", value: "engineer", confidence: 0.9, inferred: true }],
        }),
      },
      schema: ProfileSchema,
    });

    const result = await factSheet.observe({ userId: "u-inf", input: "hi", mode: "sync" });
    expect(result.profile.role).toBe("engineer");
    const stored = await adapter.get("u-inf");
    expect(stored?.provenance.role.source).toBe("inferred");
  });

  it("propagates extractor latency", async () => {
    const factSheet = new FactSheet({
      storage: new MemoryAdapter(),
      extractor: {
        baseURL: "http://localhost",
        apiKey: "test",
        model: "test-model",
        custom: async () => ({
          candidates: [{ field: "name", value: "Ada", confidence: 1, inferred: false }],
          latencyMs: 123,
        }),
      },
      schema: ProfileSchema,
    });

    const result = await factSheet.observe({ userId: "u-lat", input: "hello", mode: "sync" });
    expect(result.latencyMs).toBe(123);
  });

  it("emits observe_complete for async observe", async () => {
    const factSheet = new FactSheet({
      storage: new MemoryAdapter(),
      extractor: {
        baseURL: "http://localhost",
        apiKey: "test",
        model: "test-model",
        custom: async () => ({
          candidates: [{ field: "name", value: "Ada", confidence: 1, inferred: false }],
        }),
      },
      schema: ProfileSchema,
    });

    const payloadPromise = new Promise<{
      userId: string;
      requestId: string;
      result?: any;
      error?: unknown;
    }>((resolve) => factSheet.on("observe_complete", (p) => resolve(p as any)));

    const queued = await factSheet.observe({ userId: "u-async", input: "hello", mode: "async" });
    expect(queued.queued).toBe(true);
    expect(queued.requestId).toBeDefined();

    const payload = await payloadPromise;
    expect(payload.requestId).toBe(queued.requestId);
    expect(payload.result?.profile.name).toBe("Ada");
  });

  it("returns null from factsForPrompt for missing user", async () => {
    const factSheet = new FactSheet({
      storage: new MemoryAdapter(),
      schema: ProfileSchema,
    });

    const empty = await factSheet.factsForPrompt("missing-user");
    expect(empty).toBeNull();
  });

  it("returns JSON from factsForPrompt for existing user", async () => {
    const factSheet = new FactSheet({
      storage: new MemoryAdapter(),
      schema: ProfileSchema,
    });

    await factSheet.patch({
      userId: "u3",
      facts: { name: "Bob", role: "engineer" },
      source: "manual",
    });

    const facts = await factSheet.factsForPrompt("u3");
    expect(facts).not.toBeNull();
    const parsed = JSON.parse(facts!);
    expect(parsed).toEqual({ name: "Bob", role: "engineer" });
  });
});







