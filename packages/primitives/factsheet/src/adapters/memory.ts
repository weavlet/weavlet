import { ConcurrencyError, type StorageAdapter, type StorageHistoryOptions, type StorageHistoryResult, type StorageRecord, type StorageSetOptions } from "../storage/types";
import type { HistoryEntry } from "../types";

interface MemoryEntry extends StorageRecord {
  history: HistoryEntry[];
}

interface MemoryOptions {
  maxHistory?: number;
}

export class MemoryAdapter implements StorageAdapter {
  private readonly store = new Map<string, MemoryEntry>();
  private readonly maxHistory: number | undefined;

  constructor(options?: MemoryOptions) {
    this.maxHistory = options?.maxHistory;
  }

  async get(userId: string): Promise<StorageRecord | null> {
    const record = this.store.get(userId);
    if (!record) return null;
    return {
      profile: { ...record.profile },
      provenance: { ...record.provenance },
      etag: record.etag,
    };
  }


  async set(
    userId: string,
    profile: Record<string, unknown>,
    provenance: Record<string, any>,
    options?: StorageSetOptions,
    historyEntries?: HistoryEntry[]
  ): Promise<{ etag: string }> {
    const existing = this.store.get(userId);
    if (options?.etag && existing && existing.etag !== options.etag && !options.force) {
      throw new ConcurrencyError("etag mismatch", existing.etag);
    }

    const nextEtag = existing ? String(Number(existing.etag) + 1) : "1";
    const history = existing?.history ?? [];

    if (historyEntries) {
      history.push(...historyEntries);
      if (this.maxHistory && history.length > this.maxHistory) {
        history.splice(0, history.length - this.maxHistory);
      }
    }

    this.store.set(userId, {
      profile: { ...profile },
      provenance: { ...provenance },
      etag: nextEtag,
      history,
    });
    return { etag: nextEtag };
  }

  async appendHistory(userId: string, entry: HistoryEntry): Promise<void> {
    const existing = this.store.get(userId);
    if (!existing) {
      this.store.set(userId, {
        profile: {},
        provenance: {},
        etag: "1",
        history: [entry],
      });
      return;
    }
    existing.history.push(entry);
    if (this.maxHistory && existing.history.length > this.maxHistory) {
      existing.history.splice(0, existing.history.length - this.maxHistory);
    }
  }

  async getHistory(userId: string, options?: StorageHistoryOptions): Promise<StorageHistoryResult> {
    const existing = this.store.get(userId);
    if (!existing) return { entries: [] };
    const limit = options?.limit ?? 50;
    const cursorTs = options?.cursor ? Number(options.cursor) : -Infinity;
    const filtered = existing.history
      .filter((entry) => (options?.field ? entry.field === options.field : true))
      .filter((entry) => entry.timestamp > cursorTs)
      .sort((a, b) => a.timestamp - b.timestamp);

    const entries = filtered.slice(0, limit);
    const nextCursor = filtered.length > limit ? String(entries[entries.length - 1].timestamp) : undefined;
    return { entries, nextCursor };
  }

  async delete(userId: string): Promise<void> {
    this.store.delete(userId);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}







