// deploy/backup.sh (#18): a backup set is a dump and a documents archive,
// both validated under temporary names before the set's manifest publishes
// them; --status and retention count complete sets only.
//
// No daemon is touched: `docker` and `date` are stubs first on PATH, HOME and
// the backup destination are temp directories.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../deploy/backup.sh", import.meta.url).pathname;
const realDate = Bun.which("date")!;

const DOCKER_STUB = `#!/usr/bin/env bash
# Test stand-in for docker: knows the three calls backup.sh makes, nothing else.
echo "$*" >> "$STUB_LOG"
case "$*" in
  "compose exec -T db sh -c pg_dump -Fc -U \\"\\$POSTGRES_USER\\" -d \\"\\$POSTGRES_DB\\"")
    printf 'PGDMP stub dump %s\\n' "$STUB_STAMP" ;;
  "compose exec -T db pg_restore -l")
    [ "$(head -c 5)" = PGDMP ] ;;
  "run --rm -v hovedbok-test_documents:/src:ro alpine:3 tar -czf - -C /src .")
    t="$(mktemp)"
    tar -czf "$t" -C "$STUB_DOCS" .
    case "$STUB_TAR" in
      ok) cat "$t"; rm -f "$t" ;;
      truncated) head -c "$(( $(stat -c %s "$t") / 2 ))" "$t"; rm -f "$t"; exit 23 ;;
      truncated-exit-0) head -c "$(( $(stat -c %s "$t") / 2 ))" "$t"; rm -f "$t" ;;
      held) # stays in the archive step until the test creates $STUB_RELEASE
        echo "$$" > "$STUB_HELD"
        while [ ! -e "$STUB_RELEASE" ]; do sleep 0.02; done
        cat "$t"; rm -f "$t" ;;
      *) echo "docker stub: bad STUB_TAR=$STUB_TAR" >&2; exit 98 ;;
    esac ;;
  *) echo "docker stub: unexpected call: $*" >&2; exit 99 ;;
esac
`;

const DATE_STUB = `#!/usr/bin/env bash
# The backup's stamp is STUB_STAMP; every other use of date is the real one.
if [ "$1" = "+%Y%m%d-%H%M%S" ]; then echo "$STUB_STAMP"; exit; fi
exec ${realDate} "$@"
`;

let tmp: string;
let dest: string;
let docs: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "hovedbok-backup-"));
  dest = join(tmp, "backups");
  docs = join(tmp, "documents");
  await mkdir(join(tmp, "bin"));
  await mkdir(join(tmp, "stack"));
  await mkdir(join(tmp, "home"));
  await mkdir(join(docs, "ab"), { recursive: true });
  // Incompressible, so half the archive is well short of its end.
  await writeFile(join(docs, "ab", "blob1"), crypto.getRandomValues(new Uint8Array(16384)));
  await writeFile(join(docs, "ab", "blob2"), "a receipt");
  await writeFile(join(tmp, "bin", "docker"), DOCKER_STUB);
  await writeFile(join(tmp, "bin", "date"), DATE_STUB);
  await chmod(join(tmp, "bin", "docker"), 0o755);
  await chmod(join(tmp, "bin", "date"), 0o755);
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

type Run = { code: number; out: string };

type Opts = { stamp?: string; tar?: string; env?: Record<string, string> };

function stubEnv(opts: Opts): Record<string, string> {
  return {
    PATH: `${join(tmp, "bin")}:${process.env.PATH}`,
    HOME: join(tmp, "home"),
    HOVEDBOK_DIR: join(tmp, "stack"),
    HOVEDBOK_BACKUP_DEST: dest,
    COMPOSE_PROJECT_NAME: "hovedbok-test",
    STUB_LOG: join(tmp, "docker.log"),
    STUB_DOCS: docs,
    STUB_STAMP: opts.stamp ?? "20261015-020000",
    STUB_TAR: opts.tar ?? "ok",
    STUB_HELD: join(tmp, "held.pid"),
    STUB_RELEASE: join(tmp, "release"),
    ...opts.env,
  };
}

function backup(args: string[], opts: Opts = {}): Run {
  const p = Bun.spawnSync(["bash", SCRIPT, ...args], {
    env: stubEnv(opts),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode ?? -1, out: p.stdout.toString() + p.stderr.toString() };
}

const status = () => backup(["--status"]);

async function ls(dir: string): Promise<string[]> {
  return (await readdir(join(dest, dir)).catch(() => [] as string[])).sort();
}

const set = (base: string) => [`${base}.documents.tar.gz`, `${base}.dump`, `${base}.sha256`];

/** The set verifies by its manifest and the archive restores the documents. */
async function expectRestorable(dir: string, base: string): Promise<void> {
  const check = Bun.spawnSync(["sha256sum", "--strict", "-c", `${base}.sha256`], { cwd: join(dest, dir) });
  expect(check.exitCode).toBe(0);
  const into = await mkdtemp(join(tmp, "restore-"));
  const x = Bun.spawnSync(["tar", "-xzf", join(dest, dir, `${base}.documents.tar.gz`), "-C", into]);
  expect(x.exitCode).toBe(0);
  expect(await readFile(join(into, "ab", "blob1"))).toEqual(await readFile(join(docs, "ab", "blob1")));
  expect(await readFile(join(into, "ab", "blob2"), "utf8")).toBe("a receipt");
  expect(await readFile(join(dest, dir, `${base}.dump`), "utf8")).toStartWith("PGDMP");
}

// ---------------------------------------------------------------------------
describe("a backup run", () => {
  test("publishes dump, archive and manifest as one set; status is healthy", async () => {
    const r = backup([]);
    expect(r.out).toContain("OK ");
    expect(r.code).toBe(0);
    expect(await ls("daily")).toEqual(set("hovedbok-20261015-020000"));
    await expectRestorable("daily", "hovedbok-20261015-020000");
    expect(await ls("monthly")).toEqual([]);

    const s = status();
    expect(s.out).toContain("daily      1 complete sets, 0 incomplete");
    expect(s.out).toContain("newest: ");
    expect(s.code).toBe(0);
  });

  test("an archive that fails (truncated, exit 23) publishes nothing, keeps the prior set, and status fails", async () => {
    expect(backup([], { stamp: "20261014-020000" }).code).toBe(0);

    // The issue's reproduction: pg_dump and pg_restore -l succeed, tar
    // writes half an archive and exits 23.
    const r = backup([], { stamp: "20261015-020000", tar: "truncated" });
    expect(r.code).toBe(23);
    expect(await ls("daily")).toEqual(["FAILED", ...set("hovedbok-20261014-020000")]);
    expect(await readFile(join(dest, "daily", "FAILED"), "utf8")).toContain("hovedbok-20261015-020000 exit 23");
    await expectRestorable("daily", "hovedbok-20261014-020000");

    const s = status();
    expect(s.out).toContain("FAILED: last daily run");
    expect(s.code).not.toBe(0);

    // The next good run clears it.
    expect(backup([], { stamp: "20261016-020000" }).code).toBe(0);
    expect(await ls("daily")).toEqual([...set("hovedbok-20261014-020000"), ...set("hovedbok-20261016-020000")]);
    expect(status().code).toBe(0);
  });

  test("with no prior set, the failed run leaves no dump behind and status fails", async () => {
    const r = backup([], { tar: "truncated" });
    expect(r.code).toBe(23);
    expect(await ls("daily")).toEqual(["FAILED"]);
    const s = status();
    expect(s.out).toContain("NO COMPLETE DAILY SET");
    expect(s.code).not.toBe(0);
  });

  test("a truncated archive is refused even when tar exits 0", async () => {
    const r = backup([], { tar: "truncated-exit-0" });
    expect(r.code).not.toBe(0);
    expect(await ls("daily")).toEqual(["FAILED"]);
    expect(status().code).not.toBe(0);
  });

  test("a dump pg_restore cannot list is refused before the archive is taken", async () => {
    await writeFile(
      join(tmp, "bin", "docker"),
      DOCKER_STUB.replace("printf 'PGDMP stub dump", "printf 'garbage"),
    );
    const r = backup([]);
    expect(r.code).not.toBe(0);
    expect(await ls("daily")).toEqual(["FAILED"]);
    expect(await readFile(join(tmp, "docker.log"), "utf8")).not.toContain("alpine");
  });

  test("a tagged set lives outside retention; a bad tag is refused", async () => {
    expect(backup(["--tag", "pre-deploy"]).code).toBe(0);
    expect(await ls("tagged")).toEqual(set("hovedbok-20261015-020000-pre-deploy"));
    await expectRestorable("tagged", "hovedbok-20261015-020000-pre-deploy");
    expect(backup(["--tag", "../x"]).code).toBe(2);

    expect(backup(["--tag", "next"], { tar: "truncated" }).code).toBe(23);
    expect(await ls("tagged")).toEqual(["FAILED", ...set("hovedbok-20261015-020000-pre-deploy")]);
    backup([]);
    const s = status();
    expect(s.out).toContain("FAILED: last tagged run");
    expect(s.code).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("--status checks the newest complete set, not the newest dump", () => {
  const base = "hovedbok-20261015-020000";
  const archive = () => join(dest, "daily", `${base}.documents.tar.gz`);

  test("a truncated archive is corrupt", async () => {
    expect(backup([]).code).toBe(0);
    await truncate(archive(), (await stat(archive())).size - 100);
    const s = status();
    expect(s.out).toContain(`CORRUPT: ${base}`);
    expect(s.code).not.toBe(0);
  });

  test("a changed byte in the archive fails its checksum", async () => {
    expect(backup([]).code).toBe(0);
    const bytes = await readFile(archive());
    bytes[100] = bytes[100]! ^ 0xff;
    await writeFile(archive(), bytes);
    const s = status();
    expect(s.out).toContain(`CORRUPT: ${base}`);
    expect(s.code).not.toBe(0);
  });

  test("a missing archive leaves no complete set", async () => {
    expect(backup([]).code).toBe(0);
    await rm(archive());
    const s = status();
    expect(s.out).toContain("daily      0 complete sets, 1 incomplete");
    expect(s.out).toContain("NO COMPLETE DAILY SET");
    expect(s.code).not.toBe(0);
  });

  test("no backup directory at all fails status", () => {
    const s = status();
    expect(s.out).toContain("NO COMPLETE DAILY SET");
    expect(s.code).toBe(1);
  });

  test("what the old script left (a dump and a tarball, no manifest) is not a backup", async () => {
    await mkdir(join(dest, "daily"), { recursive: true });
    await writeFile(join(dest, "daily", `${base}.dump`), "PGDMP");
    await writeFile(join(dest, "daily", `${base}.documents.tar.gz`), "half");
    const s = status();
    expect(s.out).toContain("NO COMPLETE DAILY SET");
    expect(s.code).not.toBe(0);
  });

  test("a set newer than the newest complete one, never finished, fails status", async () => {
    expect(backup([]).code).toBe(0);
    await writeFile(join(dest, "daily", "hovedbok-20261016-020000.dump"), "PGDMP");
    const s = status();
    expect(s.out).toContain("INCOMPLETE: hovedbok-20261016-020000");
    expect(s.code).not.toBe(0);
  });

  test("a stale set fails status", async () => {
    expect(backup([]).code).toBe(0);
    const old = new Date(Date.now() - 40 * 3600 * 1000);
    await utimes(join(dest, "daily", `${base}.sha256`), old, old);
    const s = status();
    expect(s.out).toContain("STALE");
    expect(s.code).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("retention counts complete sets only", () => {
  test("keeps the newest DAILY_KEEP complete sets; failed runs and leftovers do not count", async () => {
    const env = { HOVEDBOK_BACKUP_DAILY_KEEP: "2" };
    await mkdir(join(dest, "daily"), { recursive: true });
    // Old-format leftovers and a crashed run's partial: they stay until there
    // are DAILY_KEEP complete sets to stand in for them, then go.
    await writeFile(join(dest, "daily", "hovedbok-20261001-020000.dump"), "PGDMP");
    await writeFile(join(dest, "daily", "hovedbok-20261001-020000.documents.tar.gz"), "x");
    await writeFile(join(dest, "daily", "hovedbok-20261002-020000.dump.partial"), "PGD");

    expect(backup([], { stamp: "20261010-020000", env }).code).toBe(0);
    // Failures neither count towards DAILY_KEEP nor push anything out.
    expect(backup([], { stamp: "20261011-020000", env, tar: "truncated" }).code).toBe(23);
    expect(backup([], { stamp: "20261012-020000", env, tar: "truncated" }).code).toBe(23);
    expect(await ls("daily")).toEqual([
      "FAILED",
      "hovedbok-20261001-020000.documents.tar.gz",
      "hovedbok-20261001-020000.dump",
      "hovedbok-20261002-020000.dump.partial",
      ...set("hovedbok-20261010-020000"),
    ]);

    expect(backup([], { stamp: "20261013-020000", env }).code).toBe(0);
    expect(await ls("daily")).toEqual([...set("hovedbok-20261010-020000"), ...set("hovedbok-20261013-020000")]);

    expect(backup([], { stamp: "20261014-020000", env }).code).toBe(0);
    expect(await ls("daily")).toEqual([...set("hovedbok-20261013-020000"), ...set("hovedbok-20261014-020000")]);
    await expectRestorable("daily", "hovedbok-20261013-020000");
    expect(status().code).toBe(0);
  });

  test("the set taken on the 1st is copied whole to monthly, which keeps MONTHLY_KEEP", async () => {
    const env = { HOVEDBOK_BACKUP_MONTHLY_KEEP: "1" };
    expect(backup([], { stamp: "20261001-020000", env }).code).toBe(0);
    expect(backup([], { stamp: "20261101-020000", env }).code).toBe(0);
    expect(await ls("monthly")).toEqual(set("hovedbok-20261101-020000"));
    await expectRestorable("monthly", "hovedbok-20261101-020000");
    expect(status().out).toContain("monthly    1 complete sets, 0 incomplete");
  });
});

// ---------------------------------------------------------------------------
describe("an interrupted run never leaves status green", () => {
  const prior = "hovedbok-20261014-020000";
  const base = "hovedbok-20261015-020000";

  /** Starts a run held in its archive step; resolves once it is there. */
  async function heldRun() {
    const proc = Bun.spawn(["bash", SCRIPT], { env: stubEnv({ tar: "held" }), stdout: "pipe", stderr: "pipe" });
    const held = join(tmp, "held.pid");
    for (let i = 0; !(await Bun.file(held).exists()) || (await readFile(held, "utf8")) === ""; i++) {
      if (i > 500) throw new Error("the run never reached its archive step");
      await Bun.sleep(10);
    }
    const stub = Number((await readFile(held, "utf8")).trim());
    return { proc, stub, release: () => writeFile(join(tmp, "release"), "") };
  }

  test("while it runs, status shows it and stays green", async () => {
    expect(backup([], { stamp: "20261014-020000" }).code).toBe(0);
    const run = await heldRun();
    try {
      const s = status();
      expect(s.out).toContain(`RUNNING: ${base} (pid ${run.proc.pid})`);
      expect(s.code).toBe(0);
    } finally {
      await run.release();
    }
    expect(await run.proc.exited).toBe(0);
    expect(await ls("daily")).toEqual([...set(prior), ...set(base)]);
    expect(status().code).toBe(0);
  });

  test("SIGTERM to the script alone is a failure, even if the step it waited on succeeds", async () => {
    expect(backup([], { stamp: "20261014-020000" }).code).toBe(0);
    const run = await heldRun();
    run.proc.kill("SIGTERM");
    await run.release();
    expect(await run.proc.exited).toBe(143);
    expect(await ls("daily")).toEqual(["FAILED", ...set(prior)]);
    const s = status();
    expect(s.out).toContain(`FAILED: last daily run: `);
    expect(s.out).toContain(`${base} exit 143`);
    expect(s.code).not.toBe(0);
  });

  test("SIGTERM to script and child together (systemd stopping the unit) is a failure", async () => {
    expect(backup([], { stamp: "20261014-020000" }).code).toBe(0);
    const run = await heldRun();
    try {
      process.kill(run.stub, "SIGTERM");
      run.proc.kill("SIGTERM");
      expect(await run.proc.exited).toBe(143);
    } finally {
      await run.release();
    }
    expect(await ls("daily")).toEqual(["FAILED", ...set(prior)]);
    expect(status().code).not.toBe(0);
  });

  test("SIGKILL (no trap runs) leaves a RUNNING marker that fails status until a good run", async () => {
    expect(backup([], { stamp: "20261014-020000" }).code).toBe(0);
    const run = await heldRun();
    run.proc.kill("SIGKILL");
    await run.proc.exited;
    await run.release();
    for (let i = 0; i < 500 && (await Bun.file(`/proc/${run.stub}/stat`).exists()); i++) await Bun.sleep(10);
    expect(await ls("daily")).toContain(`RUNNING.${base}`);
    const s = status();
    expect(s.out).toContain(`INTERRUPTED: ${base}`);
    expect(s.code).not.toBe(0);

    expect(backup([], { stamp: "20261016-020000" }).code).toBe(0);
    expect(await ls("daily")).not.toContain(`RUNNING.${base}`);
    expect(status().code).toBe(0);
  });

  test("a run refused before any work (its set already exists) still records failure", async () => {
    expect(backup([]).code).toBe(0);
    const r = backup([]);
    expect(r.out).toContain("already exists");
    expect(r.code).toBe(1);
    expect(await ls("daily")).toEqual(["FAILED", ...set(base)]);
  });
});
