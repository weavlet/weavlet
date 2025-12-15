type Handler<T> = (payload: T) => void;

export class EventEmitter<TEvents extends Record<string, any>> {
  private listeners: { [K in keyof TEvents]?: Set<Handler<TEvents[K]>> } = {};

  on<K extends keyof TEvents>(event: K, handler: Handler<TEvents[K]>): () => void {
    if (!this.listeners[event]) {
      this.listeners[event] = new Set();
    }
    this.listeners[event]!.add(handler);
    return () => this.off(event, handler);
  }

  off<K extends keyof TEvents>(event: K, handler: Handler<TEvents[K]>): void {
    this.listeners[event]?.delete(handler);
  }

  emit<K extends keyof TEvents>(event: K, payload: TEvents[K]): void {
    this.listeners[event]?.forEach((handler) => {
      try {
        handler(payload);
      } catch (error) {
        // Log handler errors but don't rethrow to avoid cascading failures
        console.error(
          `[EventEmitter] Error in handler for event "${String(event)}":`,
          error
        );
      }
    });
  }
}







