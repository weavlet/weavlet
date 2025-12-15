/**
 * Thrown when optimistic locking fails due to concurrent modifications.
 */
export class ConcurrencyError extends Error {
  constructor(message: string, readonly currentEtag?: string) {
    super(message);
    this.name = "ConcurrencyError";
  }
}

/**
 * Thrown when an operation requires a schema but none has been registered.
 */
export class SchemaNotRegisteredError extends Error {
  constructor(message = "Schema is not registered") {
    super(message);
    this.name = "SchemaNotRegisteredError";
  }
}

/**
 * Thrown when extraction is attempted but no extractor is configured.
 */
export class ExtractorNotConfiguredError extends Error {
  constructor(message = "Extractor is not configured") {
    super(message);
    this.name = "ExtractorNotConfiguredError";
  }
}

/**
 * Thrown when schema validation fails.
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    readonly field?: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Thrown when storage operations fail (read, write, connection issues).
 */
export class StorageError extends Error {
  constructor(
    message: string,
    readonly operation?: "read" | "write" | "delete" | "init",
    readonly cause?: Error
  ) {
    super(message);
    this.name = "StorageError";
  }
}

/**
 * Thrown when persistence fails after all retry attempts have been exhausted.
 */
export class PersistenceError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly cause?: Error
  ) {
    super(message);
    this.name = "PersistenceError";
    // Standard way to chain errors in modern JS/TS
    if (cause) {
      this.cause = cause;
    }
  }
}







