import { test, expect } from "bun:test";
import { readdir } from "node:fs/promises";

test("migrations are sequentially numbered", async () => {
  const dir = new URL("../db/migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  expect(files.length).toBeGreaterThan(0);
  files.forEach((f, i) => {
    expect(f).toMatch(new RegExp(`^${String(i + 1).padStart(4, "0")}_`));
  });
});
