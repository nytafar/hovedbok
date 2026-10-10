import { test, expect } from "bun:test";
import { readdir } from "node:fs/promises";

// The migrator applies files in name order, so what matters is a unique,
// zero-padded number per file. Gaps are allowed: parallel branches reserve
// number ranges and land out of order.
test("migrations are uniquely numbered", async () => {
  const dir = new URL("../db/migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  expect(files.length).toBeGreaterThan(0);
  expect(files[0]).toMatch(/^0001_/);
  const numbers = files.map((f) => {
    expect(f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    return Number(f.slice(0, 4));
  });
  numbers.slice(1).forEach((n, i) => expect(n).toBeGreaterThan(numbers[i]!));
});
