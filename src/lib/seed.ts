/**
 * Demo seed data.
 *
 * When EdgeHive boots in demo mode (`EDGEHIVE_DEMO=1`) it populates a couple of
 * collections with realistic documents so a portfolio visitor lands on a live,
 * already-populated instance instead of an empty one. The seed is idempotent
 * per-process: it only writes when the target collections are empty.
 *
 * Runtime-agnostic — it talks to the same `Store` the app uses, so it works
 * against both the in-memory store and the Firestore emulator.
 */

import type { Store } from "./store.ts";
import type { Json } from "./firestore-rest.ts";

interface SeedDoc {
  collection: string;
  data: Record<string, Json>;
}

const now = Date.now();
const min = 60_000;

export const SEED_DOCS: SeedDoc[] = [
  {
    collection: "messages",
    data: { text: "Welcome to EdgeHive — this feed is live.", from: "system", at: now - 30 * min },
  },
  {
    collection: "messages",
    data: { text: "Open a second browser tab to watch realtime fan-out.", from: "guide", at: now - 20 * min },
  },
  {
    collection: "messages",
    data: { text: "Same server code runs on Bun, Deno and Node.", from: "guide", at: now - 10 * min },
  },
  {
    collection: "todos",
    data: { title: "Try creating a document", done: true, priority: 1, at: now - 25 * min },
  },
  {
    collection: "todos",
    data: { title: "Subscribe to the SSE stream", done: true, priority: 2, at: now - 18 * min },
  },
  {
    collection: "todos",
    data: { title: "Filter with ?where=done==false", done: false, priority: 3, at: now - 5 * min },
  },
  {
    collection: "todos",
    data: { title: "Paginate with ?limit=&pageToken=", done: false, priority: 4, at: now - 2 * min },
  },
];

/**
 * Seed the demo collections if they are empty. Returns the number of documents
 * written (0 when already populated).
 */
export async function seedDemoData(store: Store): Promise<number> {
  const collections = [...new Set(SEED_DOCS.map((d) => d.collection))];
  for (const col of collections) {
    const existing = await store.list(col);
    if (existing.length > 0) return 0; // already seeded
  }
  let written = 0;
  for (const doc of SEED_DOCS) {
    await store.create(doc.collection, doc.data);
    written += 1;
  }
  return written;
}
