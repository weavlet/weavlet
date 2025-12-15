import Redis, { type Redis as RedisClient } from "ioredis";
import { ConcurrencyError } from "../errors";
import type {
  StorageAdapter,
  StorageHistoryOptions,
  StorageHistoryResult,
  StorageRecord,
  StorageSetOptions,
} from "../storage/types";
import type { HistoryEntry, Provenance } from "../types";

export interface RedisAdapterOptions {
  url?: string;
  client?: RedisClient;
  keyPrefix?: string;
  ttlSeconds?: number;
  historyTtlSeconds?: number;
}

const LUA_SET = `
local profileKey = KEYS[1]
local provKey = KEYS[2]
local metaKey = KEYS[3]
local historyKey = KEYS[4]
local expected = ARGV[1]
local ttl = tonumber(ARGV[2])
local profile = ARGV[3]
local prov = ARGV[4]
local force = ARGV[5] == "1"
local historyRaw = ARGV[6]
local historyTtl = tonumber(ARGV[7])

local current = redis.call("GET", metaKey)
if current == false then
current = "0"
end

if expected ~= "" and not force and current ~= expected then
return { "CONFLICT", current }
end

local nextVersion = tostring(tonumber(current) + 1)
redis.call("SET", profileKey, profile)
redis.call("SET", provKey, prov)
redis.call("SET", metaKey, nextVersion)

if ttl > 0 then
redis.call("PEXPIRE", profileKey, ttl)
redis.call("PEXPIRE", provKey, ttl)
redis.call("PEXPIRE", metaKey, ttl)
end

if historyKey and historyRaw ~= "" then
  local history = cjson.decode(historyRaw)
for _, entry in ipairs(history) do
  redis.call("ZADD", historyKey, entry.timestamp, cjson.encode(entry))
  end
  if historyTtl > 0 then
redis.call("PEXPIRE", historyKey, historyTtl)
end
end

return { "OK", nextVersion }
  `;

export class RedisAdapter implements StorageAdapter {
  private readonly client: RedisClient;
  private readonly keyPrefix: string;
  private readonly ttlMs: number;
  private readonly historyTtlMs?: number;

  constructor(options: RedisAdapterOptions) {
    if (!options.client && !options.url) {
      throw new Error("RedisAdapter requires either a client or url");
    }
    this.client = options.client ?? new Redis(options.url!);
    this.keyPrefix = options.keyPrefix ?? "fs:";
    this.ttlMs = (options.ttlSeconds ?? 0) * 1000;
    this.historyTtlMs = options.historyTtlSeconds ? options.historyTtlSeconds * 1000 : undefined;
  }

  async get(userId: string): Promise<StorageRecord | null> {
    const [profileRaw, provRaw, etag] = await this.client.mget(
      this.profileKey(userId),
      this.provKey(userId),
      this.metaKey(userId)
    );
    if (!profileRaw || !provRaw || !etag) return null;

    return {
      profile: JSON.parse(profileRaw),
      provenance: JSON.parse(provRaw),
      etag,
    };
  }

  async set(
    userId: string,
    profile: Record<string, unknown>,
    provenance: Record<string, Provenance>,
    options?: StorageSetOptions,
    history?: HistoryEntry[]
  ): Promise<{ etag: string }> {
    const res = (await this.client.eval(
      LUA_SET,
      4,
      this.profileKey(userId),
      this.provKey(userId),
      this.metaKey(userId),
      this.historyKey(userId),
      options?.etag ?? "",
      this.ttlMs,
      JSON.stringify(profile),
      JSON.stringify(provenance),
      options?.force ? "1" : "0",
      history && history.length > 0 ? JSON.stringify(history) : "",
      this.historyTtlMs ?? 0
    )) as [string, string];

    if (res[0] === "CONFLICT") {
      throw new ConcurrencyError("etag mismatch", res[1]);
    }

    return { etag: res[1] };
  }

  async appendHistory(userId: string, entry: HistoryEntry): Promise<void> {
    await this.client.zadd(this.historyKey(userId), entry.timestamp, JSON.stringify(entry));
    if (this.historyTtlMs) {
      await this.client.pexpire(this.historyKey(userId), this.historyTtlMs);
    }
  }

  async getHistory(userId: string, options?: StorageHistoryOptions): Promise<StorageHistoryResult> {
    const limit = options?.limit ?? 50;
    const min = options?.cursor ? `(${options.cursor}` : "-inf";
    const max = "+inf";
    const rawEntries = await this.client.zrangebyscore(
      this.historyKey(userId),
      min,
      max,
      "LIMIT",
      0,
      limit + 1
    );
    const entries = rawEntries.slice(0, limit).map((e) => JSON.parse(e) as HistoryEntry);
    const last = entries[entries.length - 1];
    const nextCursor = rawEntries.length > limit && last ? String(last.timestamp) : undefined;
    return { entries, nextCursor };
  }

  async delete(userId: string): Promise<void> {
    await this.client.del(
      this.profileKey(userId),
      this.provKey(userId),
      this.metaKey(userId),
      this.historyKey(userId)
    );
  }

  async healthCheck(): Promise<boolean> {
    const res = await this.client.ping();
    return res === "PONG";
  }

  private profileKey(userId: string) {
    return `${this.keyPrefix}profile: ${userId}`;
  }

  private provKey(userId: string) {
    return `${this.keyPrefix}prov: ${userId}`;
  }

  private metaKey(userId: string) {
    return `${this.keyPrefix}meta: ${userId}`;
  }

  private historyKey(userId: string) {
    return `${this.keyPrefix}history: ${userId}`;
  }
}







