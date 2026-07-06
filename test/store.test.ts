/**
 * Store parity + Firestore value-codec tests.
 *
 * The `MemoryStore` and `FirestoreStore` must be behaviourally identical so the
 * app behaves the same whether or not the Firebase emulator is running. Here we
 * exercise the memory store directly and unit-test the Firestore value codec
 * that `FirestoreStore` relies on, so a live emulator is not required in CI.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryStore } from "../src/lib/store.ts";
import {
  toFsValue,
  fromFsValue,
  objectToFields,
  fieldsToObject,
  docIdFromName,
  type Json,
} from "../src/lib/firestore-rest.ts";

test("MemoryStore: create assigns an id and preserves data", async () => {
  const s = new MemoryStore();
  const doc = await s.create("things", { a: 1, b: "two" });
  assert.ok(doc.id.length > 0);
  assert.deepEqual(doc.data, { a: 1, b: "two" });
  assert.ok(doc.createTime);
});

test("MemoryStore: get returns null for a missing document", async () => {
  const s = new MemoryStore();
  assert.equal(await s.get("things", "nope"), null);
});

test("MemoryStore: set upserts and preserves createTime on update", async () => {
  const s = new MemoryStore();
  const first = await s.set("k", "id1", { v: 1 });
  const second = await s.set("k", "id1", { v: 2 });
  assert.equal(second.data.v, 2);
  assert.equal(second.createTime, first.createTime);
});

test("MemoryStore: list and delete behave correctly", async () => {
  const s = new MemoryStore();
  await s.create("c", { n: 1 });
  await s.create("c", { n: 2 });
  assert.equal((await s.list("c")).length, 2);

  const doc = await s.create("c", { n: 3 });
  await s.delete("c", doc.id);
  assert.equal((await s.list("c")).length, 2);
  // Deleting a missing doc is a no-op.
  await s.delete("c", "does-not-exist");
});

test("MemoryStore: returned documents are deep copies (no aliasing)", async () => {
  const s = new MemoryStore();
  const doc = await s.create("c", { nested: { x: 1 } });
  (doc.data.nested as { x: number }).x = 999;
  const fresh = await s.get("c", doc.id);
  assert.equal((fresh!.data.nested as { x: number }).x, 1);
});

test("Firestore codec: round-trips all supported value types", () => {
  const values: Json[] = [
    null,
    true,
    false,
    0,
    42,
    -7,
    3.14,
    "hello",
    [1, 2, 3],
    { a: 1, b: "x", c: [true, null] },
  ];
  for (const v of values) {
    assert.deepEqual(fromFsValue(toFsValue(v)), v);
  }
});

test("Firestore codec: integers vs doubles are typed correctly", () => {
  assert.deepEqual(toFsValue(42), { integerValue: "42" });
  assert.deepEqual(toFsValue(3.5), { doubleValue: 3.5 });
});

test("Firestore codec: object <-> fields map", () => {
  const obj = { name: "edge", count: 3, tags: ["a", "b"] };
  const fields = objectToFields(obj);
  assert.deepEqual(fieldsToObject(fields), obj);
});

test("docIdFromName extracts the trailing id", () => {
  assert.equal(
    docIdFromName("projects/p/databases/(default)/documents/todos/abc123"),
    "abc123",
  );
  assert.equal(docIdFromName(undefined), "");
});
