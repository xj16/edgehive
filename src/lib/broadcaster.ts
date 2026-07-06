/**
 * In-process pub/sub used to push realtime change events to connected clients
 * over Server-Sent Events (SSE).
 *
 * Every mutation to the store (create / update / delete) publishes a
 * `ChangeEvent` on a channel named after the collection. SSE handlers subscribe
 * to a channel and stream events to the browser. Because it is pure JS with no
 * runtime-specific APIs, the same broadcaster works on Bun, Deno and Node.
 *
 * For a single-process starter this in-memory bus is exactly right. The README
 * documents how to swap it for Redis / a Firestore listener when you scale to
 * multiple instances.
 */

import type { Json } from "./firestore-rest.ts";

export type ChangeType = "created" | "updated" | "deleted";

export interface ChangeEvent {
  type: ChangeType;
  collection: string;
  id: string;
  /** Present for created/updated; omitted for deleted. */
  data?: Record<string, Json>;
  /** Milliseconds since the epoch, set when the event is published. */
  ts: number;
}

type Listener = (event: ChangeEvent) => void;

export class Broadcaster {
  private readonly channels = new Map<string, Set<Listener>>();

  /**
   * Subscribe to a collection's change stream.
   * Returns an unsubscribe function — always call it when the client goes away.
   */
  subscribe(collection: string, listener: Listener): () => void {
    let set = this.channels.get(collection);
    if (!set) {
      set = new Set();
      this.channels.set(collection, set);
    }
    set.add(listener);
    return () => {
      const s = this.channels.get(collection);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.channels.delete(collection);
    };
  }

  /** Publish an event to every subscriber of its collection. */
  publish(event: ChangeEvent): void {
    const set = this.channels.get(event.collection);
    if (!set) return;
    // Copy first so a listener that unsubscribes mid-iteration is safe.
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        // A single bad listener must never break the fan-out.
      }
    }
  }

  /** Number of active subscribers for a collection (used by /health & tests). */
  subscriberCount(collection: string): number {
    return this.channels.get(collection)?.size ?? 0;
  }

  /** Total active subscribers across all channels. */
  totalSubscribers(): number {
    let n = 0;
    for (const set of this.channels.values()) n += set.size;
    return n;
  }
}

/** Serialise a ChangeEvent into an SSE `data:` frame. */
export function toSseFrame(event: ChangeEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
