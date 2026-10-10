import { test, expect } from "bun:test";
import { readdir } from "node:fs/promises";

// The migrator applies files in name order, once each: every file needs a
// unique 4-digit prefix and the order must be strictly increasing. Gaps are
// allowed — parallel work streams are handed disjoint number ranges.
test("migrations have unique, strictly increasing 4-digit prefixes", async () => {
  const dir = new URL("../db/migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  expect(files.length).toBeGreaterThan(0);
  let previous = 0;
  for (const f of files) {
    expect(f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    const n = Number(f.slice(0, 4));
    expect(n).toBeGreaterThan(previous);
    previous = n;
  }
  expect(files[0]).toMatch(/^0001_/);
});
