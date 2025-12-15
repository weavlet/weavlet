import type { HistoryEntry, ConflictPolicy, ExtractorCandidate, Provenance, RejectedField } from "./types";
import { now, truncateValue } from "./utils";

export interface MergeInput {
  profile: Record<string, unknown>;
  provenance: Record<string, Provenance>;
  candidates: Array<ExtractorCandidate & { source: string }>;
  policy: ConflictPolicy;
  allowNull: (field: string) => boolean;
  skipRecencyCheck?: boolean;
}

export interface MergeResult {
  profile: Record<string, unknown>;
  provenance: Record<string, Provenance>;
  updated: Record<string, unknown>;
  rejected: RejectedField[];
  history: HistoryEntry[];
}

const priorityOf = (policy: ConflictPolicy, source: string) =>
  policy.sourcePriority[source] ?? 0;

export function mergeCandidates(input: MergeInput): MergeResult {
  const { profile, provenance, candidates, policy, allowNull, skipRecencyCheck } = input;
  const mergedProfile = { ...profile };
  const mergedProv = { ...provenance };
  const updated: Record<string, unknown> = {};
  const rejected: RejectedField[] = [];
  const history: HistoryEntry[] = [];
  const nowTs = now();

  const resolvedTimestamp = (candidate: ExtractorCandidate & { source: string }) =>
    candidate.timestamp ?? nowTs;

  const sorted = [...candidates].sort((a, b) => {
    const prioDiff = priorityOf(policy, b.source ?? "observe") - priorityOf(policy, a.source ?? "observe");
    if (prioDiff !== 0) return prioDiff;
    const tsDiff = resolvedTimestamp(b) - resolvedTimestamp(a);
    if (tsDiff !== 0) return tsDiff;
    const confDiff = b.confidence - a.confidence;
    if (confDiff !== 0) return confDiff;
    return a.field.localeCompare(b.field);
  });

  for (const candidate of sorted) {
    const field = candidate.field;
    const candidatePriority = priorityOf(policy, candidate.source ?? "observe");
    const existingProv = mergedProv[field];
    const existingPriority = existingProv ? priorityOf(policy, existingProv.source) : -Infinity;

    if (candidate.value === undefined) {
      rejected.push({ field, value: candidate.value, reason: "schema_invalid" });
      history.push({
        field,
        value: candidate.value,
        previousValue: mergedProfile[field],
        source: candidate.source,
        timestamp: nowTs,
        confidence: candidate.confidence,
        inferred: candidate.inferred,
        action: "rejected",
        reason: "schema_invalid",
      });
      continue;
    }

    if (candidate.confidence < policy.minConfidence) {
      rejected.push({ field, value: candidate.value, reason: "low_confidence" });
      history.push({
        field,
        value: candidate.value,
        previousValue: mergedProfile[field],
        source: candidate.source,
        timestamp: nowTs,
        confidence: candidate.confidence,
        inferred: candidate.inferred,
        action: "rejected",
        reason: "low_confidence",
      });
      continue;
    }

    const candidateTimestamp = resolvedTimestamp(candidate);

    const ageDiff = existingProv ? existingProv.timestamp - candidateTimestamp : 0;

    if (
      !skipRecencyCheck &&
      existingProv &&
      candidatePriority <= existingPriority &&
      candidateTimestamp <= existingProv.timestamp &&
      ageDiff >= policy.recencyWindowMs
    ) {
      rejected.push({ field, value: candidate.value, reason: "outside_recency" });
      history.push({
        field,
        value: candidate.value,
        previousValue: mergedProfile[field],
        source: candidate.source,
        timestamp: candidateTimestamp,
        confidence: candidate.confidence,
        inferred: candidate.inferred,
        action: "rejected",
        reason: "outside_recency",
      });
      continue;
    }

    if (existingProv && candidatePriority === existingPriority && candidateTimestamp < existingProv.timestamp) {
      rejected.push({ field, value: candidate.value, reason: "older_timestamp" });
      history.push({
        field,
        value: candidate.value,
        previousValue: mergedProfile[field],
        source: candidate.source,
        timestamp: nowTs,
        confidence: candidate.confidence,
        inferred: candidate.inferred,
        action: "rejected",
        reason: "older_timestamp",
      });
      continue;
    }

    if (existingProv && candidatePriority < existingPriority) {
      rejected.push({ field, value: candidate.value, reason: "lower_priority" });
      history.push({
        field,
        value: candidate.value,
        previousValue: mergedProfile[field],
        source: candidate.source,
        timestamp: nowTs,
        confidence: candidate.confidence,
        inferred: candidate.inferred,
        action: "rejected",
        reason: "lower_priority",
      });
      continue;
    }

    if (candidate.value === null && !allowNull(field)) {
      rejected.push({ field, value: candidate.value, reason: "not_nullable" });
      history.push({
        field,
        value: candidate.value,
        previousValue: mergedProfile[field],
        source: candidate.source,
        timestamp: nowTs,
        confidence: candidate.confidence,
        inferred: candidate.inferred,
        action: "rejected",
        reason: "not_nullable",
      });
      continue;
    }

    const nextValue = truncateValue(candidate.value, policy.maxFieldLength);

    const previousValue = mergedProfile[field];
    mergedProfile[field] = nextValue as any;
    mergedProv[field] = {
      value: nextValue,
      source: candidate.source,
      timestamp: candidateTimestamp,
      confidence: candidate.confidence,
      inferred: candidate.inferred,
    };

    updated[field] = nextValue;
    history.push({
      field,
      value: nextValue,
      previousValue,
      source: candidate.source,
      timestamp: candidateTimestamp,
      confidence: candidate.confidence,
      inferred: candidate.inferred,
      action: candidate.value === null ? "delete" : "set",
    });
  }

  return { profile: mergedProfile, provenance: mergedProv, updated, rejected, history };
}

