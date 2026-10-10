import { test, expect } from "bun:test";
import { readdir } from "node:fs/promises";

// Migrations apply in name order (db/migrate.ts), so the 4-digit prefix must be
// unique and strictly increasing. Gaps are allowed: parallel branches are
// handed disjoint number ranges (#9 took 0028 while 0021-0027 were held
// elsewhere), and a range that never lands leaves a hole, never a reorder.
test("migrations carry unique, strictly increasing 4-digit numbers", async () => {
  const dir = new URL("../db/migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  expect(files.length).toBeGreaterThan(0);
  let last = 0;
  for (const f of files) {
    const m = /^(\d{4})_/.exec(f);
    expect({ f, numbered: m !== null }).toEqual({ f, numbered: true });
    const n = Number(m![1]);
    expect({ f, increasing: n > last }).toEqual({ f, increasing: true });
    last = n;
  }
});
