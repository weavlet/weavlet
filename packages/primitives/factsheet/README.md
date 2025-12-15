# @weavlet/factsheet

**Schema-driven user profile state for AI applications.**

FactSheet maintains a live, structured profile for each user by extracting facts from conversations and resolving conflicts deterministically. Instead of searching through chat history, your AI reads current truths from a single JSON object.

```typescript
import { FactSheet, MemoryAdapter } from '@weavlet/factsheet'
import { z } from 'zod'

const factSheet = new FactSheet({
  storage: new MemoryAdapter(),
  schema: z.object({
    name: z.string().optional(),
    role: z.enum(['founder', 'engineer', 'designer']).optional(),
    intent: z.enum(['learn', 'buy', 'support']).optional(),
  }),
  extractor: {
    baseURL: 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4o-mini',
  },
})

// Extract facts from conversation
await factSheet.observe({
  userId: 'user_123',
  input: "I'm Alice, CTO at Acme. Looking to migrate from Heroku.",
})

// Get current profile
const profile = await factSheet.get('user_123')
// → { name: "Alice", role: "founder", intent: "migrate" }

// Inject into your LLM prompt
const facts = await factSheet.factsForPrompt('user_123')
// → '{"intent":"migrate","name":"Alice","role":"founder"}'
```

---

## Installation

```bash
npm install @weavlet/factsheet zod
# or
pnpm add @weavlet/factsheet zod
```

---

## When to Use FactSheet

✅ **Good fit:**
- Conversational AI that needs to remember user attributes across sessions
- Sales/support agents that personalize based on role, intent, pain points
- Apps where user state drives behavior (onboarding flow, feature recommendations)
- Any case where you need structured facts, not raw conversation search

❌ **Not a fit:**
- You need to model relationships between multiple entities (use a graph)
- You need full conversation history search (use RAG)
- Your facts are deeply nested or hierarchical
- You need real-time collaborative editing of the same profile

---

## Core Concepts

### Schema

Define what facts you care about using Zod. Field descriptions are used in extraction prompts:

```typescript
const ProfileSchema = z.object({
  name: z.string().max(80).optional()
    .describe("User's full name"),
  company: z.string().optional()
    .describe("Company or organization"),
  role: z.enum(['founder', 'cto', 'engineer', 'designer', 'other']).optional()
    .describe("Job role - map VP Eng to 'cto', individual contributors to 'engineer'"),
  budget: z.enum(['none', 'low', 'medium', 'high']).optional()
    .describe("Budget level based on pricing discussions"),
  pain: z.string().max(200).optional()
    .describe("Primary pain point or problem they described"),
})
```

### Observe

Extract facts from user input (and optionally AI output):

```typescript
const result = await factSheet.observe({
  userId: 'user_123',
  input: userMessage,
  output: aiResponse,           // optional
  source: 'conversation',       // for conflict resolution
  confidence: 0.9,              // 0-1
  extractFrom: 'both',          // 'input' | 'output' | 'both'
  mode: 'sync',                 // 'sync' | 'async'
})

// result.profile    → full current profile
// result.updated    → fields changed this call
// result.rejected   → fields rejected with reasons
// result.extracted  → raw extraction before merge
```

### Patch

Manually set facts from trusted sources (CRM imports, user forms, admin):

```typescript
await factSheet.patch({
  userId: 'user_123',
  facts: { 
    company: 'Acme Corp',
    budget: 'high',
  },
  source: 'crm',        // higher priority than 'observe'
  confidence: 1.0,
})
```

### Conflict Resolution

When facts conflict, FactSheet resolves deterministically:

1. **Source priority** — `crm` beats `manual` beats `observe` beats `inferred`
2. **Recency** — newer facts can override older same-priority facts
3. **Confidence** — higher confidence wins when priority and time are equal

Configure via policy:

```typescript
new FactSheet({
  // ...
  policy: {
    sourcePriority: { crm: 3, manual: 2, observe: 1, inferred: 0 },
    minConfidence: 0.35,        // reject below this
    recencyWindowMs: 86400000,  // 24 hours
    maxFieldLength: 1024,       // truncate strings
    extrasMaxKeys: 32,          // limit 'extras' field keys
    extrasPolicy: {             // optional validation for 'extras'
      allowArrays: false,
      allowNestedObjects: false,
    },
  },
})
```

---

## Storage Adapters

### Memory (Development/Testing)

```typescript
import { MemoryAdapter } from '@weavlet/factsheet'

const storage = new MemoryAdapter({ maxHistory: 100 })
```

### PostgreSQL (Production)

```typescript
import { PostgresAdapter } from '@weavlet/factsheet'

const storage = new PostgresAdapter({
  connectionString: process.env.DATABASE_URL,
  tableName: 'factsheet_profiles',        // optional
  historyTableName: 'factsheet_history',  // optional
})

// Initialize tables (run once)
await storage.init()
```

### Redis (Production)

```typescript
import { RedisAdapter } from '@weavlet/factsheet'

const storage = new RedisAdapter({
  url: process.env.REDIS_URL,
  keyPrefix: 'fs:',           // optional
  ttlSeconds: 86400 * 30,     // optional, 30 days
  historyTtlSeconds: 86400,   // optional
})
```

### Custom Adapter

Implement the `StorageAdapter` interface:

```typescript
interface StorageAdapter {
  get(userId: string): Promise<StorageRecord | null>
  set(userId: string, profile, provenance, options?): Promise<{ etag: string }>
  appendHistory(userId: string, entry: HistoryEntry): Promise<void>
  getHistory(userId: string, options?): Promise<StorageHistoryResult>
  delete(userId: string): Promise<void>
  healthCheck?(): Promise<boolean>
}
```

### History Cursor Semantics

Each adapter uses a different cursor format for `history()` pagination:

| Adapter | Cursor Format | Description |
|---------|---------------|-------------|
| `MemoryAdapter` | Timestamp (ms) | Unix timestamp of the last entry |
| `PostgresAdapter` | Record ID | Auto-incrementing `BIGSERIAL` row ID |
| `RedisAdapter` | Score (timestamp) | Sorted set score (Unix timestamp in ms) |

Cursors are opaque strings—pass them back to `history()` without parsing.

---

## Custom Extractors

The default extractor uses OpenAI-compatible APIs. For production, you'll likely want custom logic:

```typescript
new FactSheet({
  storage: new MemoryAdapter(),
  schema: ProfileSchema,
  extractor: {
    baseURL: 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4o-mini',
    custom: async (input, output, schema, context) => {
      // Your extraction logic here
      // context provides: extractFrom, maxInputChars, timeoutMs, retries, etc.
      // Return: { candidates: [{ field, value, confidence, inferred }] }
      
      const response = await yourLLM.complete({
        prompt: buildYourPrompt(input, schema),
      })
      
      return {
        candidates: parseResponse(response),
        rawResponse: response,
        latencyMs: 100, // example
      }
    },
  },
})
```

---

## Events

React to profile changes:

```typescript
// When any field updates
factSheet.on('update', ({ userId, updated, profile }) => {
  console.log(`User ${userId} updated:`, updated)
})

// When extractions are rejected
factSheet.on('conflict', ({ userId, rejected }) => {
  console.log(`Rejected for ${userId}:`, rejected)
})

// When async observe completes
factSheet.on('observe_complete', ({ userId, requestId, result, error }) => {
  // Handle background extraction completion
})
```

---

## API Reference

### `FactSheet(config)`

| Option | Type | Description |
|--------|------|-------------|
| `storage` | `StorageAdapter` | Required. Where to persist profiles. |
| `schema` | `ZodObject` | Optional. Defines valid fields and types. Can also be set via `schema()` method. Required before calling `observe()`, `patch()`, or `get()`. |
| `extractor` | `ExtractorConfig` | Optional. LLM configuration. Required only for `observe()`. |
| `policy` | `ConflictPolicy` | Optional. Merge behavior tuning. |
| `logger` | `(msg, meta) => void` | Optional. Error logging. |

### `observe(request): ObserveResult`

Extract and merge facts from conversation.

### `patch(request): PatchResult`

Manually set facts from trusted sources.

### `get(userId): Profile | null`

Get current profile for a user.

### `history(userId, options?): { entries, nextCursor }`

Query change history with optional field filter and pagination.

### `factsForPrompt(userId, options?): string`

Get profile as compact JSON string for LLM system prompts.

### `filters(userId, options?): Record<string, unknown>`

Get non-undefined fields as a filter object.

---

## Rejection Reasons

When facts are rejected during `observe()` or `patch()`:

| Reason | Description |
|--------|-------------|
| `schema_invalid` | Value doesn't match Zod schema |
| `unknown_field` | Field not in schema |
| `low_confidence` | Below `minConfidence` threshold |
| `lower_priority` | Source priority too low to override |
| `outside_recency` | Too old compared to existing fact |
| `older_timestamp` | Timestamp is significantly older than existing fact |
| `not_nullable` | Tried to set null on non-nullable field |
| `extras_invalid` | Extras object failed validation |

---

## TypeScript

Full type inference from your Zod schema:

```typescript
const ProfileSchema = z.object({
  name: z.string(),
  active: z.boolean(),
})

const factSheet = new FactSheet({
  storage: new MemoryAdapter(),
  schema: ProfileSchema,
})

const profile = await factSheet.get('user_123')
// profile is typed as { name: string; active: boolean } | null
```

---

## License

MIT
