import type { HistoryEntry, Provenance } from "../types";
import { ConcurrencyError } from "../errors";

export interface StorageRecord {
  profile: Record<string, unknown>;
  provenance: Record<string, Provenance>;
  etag: string;
}

export interface StorageSetOptions {
  etag?: string;
  force?: boolean;
}

export interface StorageHistoryOptions {
  field?: string;
  cursor?: string;
  limit?: number;
}

export interface StorageHistoryResult {
  entries: HistoryEntry[];
  nextCursor?: string;
}

export interface StorageAdapter {
  get(userId: string): Promise<StorageRecord | null>;
  set(
    userId: string,
    profile: Record<string, unknown>,
    provenance: Record<string, Provenance>,
    options?: StorageSetOptions,
    history?: HistoryEntry[]
  ): Promise<{ etag: string }>;
  appendHistory(userId: string, entry: HistoryEntry): Promise<void>;
  getHistory(userId: string, options?: StorageHistoryOptions): Promise<StorageHistoryResult>;
  delete(userId: string): Promise<void>;
  healthCheck?(): Promise<boolean>;
}

export { ConcurrencyError };







