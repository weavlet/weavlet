import { describe, expect, it } from "vitest";
import { mergeCandidates } from "../conflict";
import { type ConflictPolicy } from "../types";

const policy: ConflictPolicy = {
  sourcePriority: { crm: 3, manual: 2, observe: 1, inferred: 0 },
  minConfidence: 0.35,
  recencyWindowMs: 24 * 60 * 60 * 1000,
  maxFieldLength: 1024,
  extrasMaxKeys: 32,
};

describe("mergeCandidates", () => {
  it("rejects stale lower-priority updates", () => {
    const now = Date.now();
    const result = mergeCandidates({
      profile: { role: "founder" },
      provenance: {
        role: {
          value: "founder",
          source: "manual",
          timestamp: now,
          confidence: 1,
          inferred: false,
        },
      },
      candidates: [
        {
          field: "role",
          value: "engineer",
          confidence: 0.9,
          inferred: false,
          source: "observe",
          // Candidate is much older than existing, so should be rejected by recency.
          timestamp: now - policy.recencyWindowMs - 1000,
        },
      ],
      policy,
      allowNull: () => false,
    });

    expect(result.profile.role).toBe("founder");
    expect(result.rejected[0]?.reason).toBe("outside_recency");
  });

  it("accepts fresher equal-priority updates", () => {
    const now = Date.now();
    const result = mergeCandidates({
      profile: { role: "founder" },
      provenance: {
        role: {
          value: "founder",
          source: "manual",
          timestamp: now - 60 * 60 * 1000,
          confidence: 1,
          inferred: false,
        },
      },
      candidates: [
        {
          field: "role",
          value: "engineer",
          confidence: 0.9,
          inferred: false,
          source: "manual",
          timestamp: now,
        },
      ],
      policy,
      allowNull: () => false,
    });

    expect(result.profile.role).toBe("engineer");
    expect(result.updated.role).toBe("engineer");
    expect(result.rejected.length).toBe(0);
  });

  it("prefers higher source priority", () => {
    const result = mergeCandidates({
      profile: { role: "founder" },
      provenance: {},
      candidates: [
        { field: "role", value: "engineer", confidence: 0.9, inferred: false, source: "crm" },
      ],
      policy,
      allowNull: () => false,
    });

    expect(result.profile.role).toBe("engineer");
    expect(result.updated.role).toBe("engineer");
    expect(result.rejected.length).toBe(0);
  });

  it("rejects updates with older timestamp even within recency window", () => {
    const now = Date.now();
    const result = mergeCandidates({
      profile: { role: "founder" },
      provenance: {
        role: {
          value: "founder",
          source: "manual",
          timestamp: now,
          confidence: 1,
          inferred: false,
        },
      },
      candidates: [
        {
          field: "role",
          value: "engineer",
          confidence: 0.9,
          inferred: false,
          source: "manual",
          // Slightly older but inside the recency window, so should be rejected by timestamp check.
          timestamp: now - 60 * 60 * 1000,
        },
      ],
      policy,
      allowNull: () => false,
    });

    expect(result.profile.role).toBe("founder");
    expect(result.updated.role).toBeUndefined();
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0].reason).toBe("older_timestamp");
  });

  it("preserves newer candidate when older candidate exists in same batch", () => {
    const now = Date.now();
    const result = mergeCandidates({
      profile: { role: "founder" },
      provenance: {},
      candidates: [
        {
          field: "role",
          value: "older value",
          confidence: 0.9,
          inferred: false,
          source: "observe",
          timestamp: now - 1000,
        },
        {
          field: "role",
          value: "newer value",
          confidence: 0.9,
          inferred: false,
          source: "observe",
          timestamp: now,
        },
      ],
      policy,
      allowNull: () => false,
    });

    expect(result.profile.role).toBe("newer value");
    expect(result.rejected.find((r) => r.value === "older value")?.reason).toBe("older_timestamp");
  });
});







