// Company profile (#15, 0032): entity.company_profile, set through
// bootstrap_entity and set_company_profile, shape-checked by a CHECK
// constraint whatever the write path.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { dropTestDb, freshDb } from "./helper";

const E = "999888777";
const PROFILE = {
  address: { street: "Storgata", number: "1", city: "Oslo", postalCode: "0155", country: "NO" },
  contact: { firstName: "Kari", lastName: "Nordmann", telephone: "+47 22 00 00 00", email: "kari@demo.no" },
  bankAccounts: [{ number: "12345678901", ledgerAccount: "1920", currency: "NOK" }],
};

let sql: SQL;
beforeAll(async () => {
  sql = await freshDb();
});
afterAll(dropTestDb);

async function bootstrap(p: object) {
  const [{ r }] = await sql`select bootstrap_entity(${p}::jsonb) as r`;
  return r;
}
async function setProfile(p: object) {
  const [{ r }] = await sql`select set_company_profile(${p}::jsonb) as r`;
  return r;
}
async function stored(orgnr = E) {
  const [{ p }] = await sql`select company_profile as p from entity where orgnr = ${orgnr}`;
  return p;
}
async function pgError(p: Promise<unknown>): Promise<{ errno: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return e as { errno: string; message: string };
  }
  throw new Error("expected a database error, but the statement succeeded");
}

describe("bootstrap_entity", () => {
  test("a new entity gets the payload's profile; the result carries it", async () => {
    const r = await bootstrap({ orgnr: E, name: "Demo AS", year: 2026, company_profile: PROFILE });
    expect(r).toMatchObject({ entity: E, created: true, company_profile: PROFILE });
    expect(await stored()).toEqual(PROFILE);
  });

  test("a re-run never overwrites a stored profile", async () => {
    const r = await bootstrap({ orgnr: E, name: "Demo AS", company_profile: { contact: { firstName: "Ola", lastName: "N" } } });
    expect(r).toMatchObject({ created: false, company_profile: PROFILE });
    expect(await stored()).toEqual(PROFILE);
  });

  test("without the key (or null) the profile is untouched; a new entity starts with {}", async () => {
    expect((await bootstrap({ orgnr: E, name: "Demo AS" })).company_profile).toEqual(PROFILE);
    expect((await bootstrap({ orgnr: E, name: "Demo AS", company_profile: null })).company_profile).toEqual(PROFILE);
    expect((await bootstrap({ orgnr: "999888776", name: "Uten AS" })).company_profile).toEqual({});
  });

  test("a re-run fills a missing ({}) profile", async () => {
    const r = await bootstrap({ orgnr: "999888776", name: "Uten AS", company_profile: { contact: PROFILE.contact } });
    expect(r).toMatchObject({ created: false, company_profile: { contact: PROFILE.contact } });
  });

  test("an invalid profile refuses the whole bootstrap", async () => {
    const e = await pgError(bootstrap({ orgnr: "999888775", name: "Feil AS", company_profile: { phone: "1" } }));
    expect(e.message).toBe("company_profile: unknown key phone; allowed: address, contact, bankAccounts");
    const [n] = await sql`select count(*)::int as n from entity where orgnr = '999888775'`;
    expect(n.n).toBe(0);
  });
});

describe("set_company_profile", () => {
  test("replaces the profile as a whole; {} clears it", async () => {
    expect(await setProfile({ entity: E, company_profile: { contact: PROFILE.contact } }))
      .toEqual({ entity: E, company_profile: { contact: PROFILE.contact } });
    expect(await stored()).toEqual({ contact: PROFILE.contact });
    await setProfile({ entity: E, company_profile: {} });
    expect(await stored()).toEqual({});
    await setProfile({ entity: E, company_profile: PROFILE });
    expect(await stored()).toEqual(PROFILE);
  });

  test("needs entity and company_profile; an unknown entity is a foreign-key refusal", async () => {
    expect((await pgError(setProfile({ entity: E }))).message).toBe("entity and company_profile are required");
    const e = await pgError(setProfile({ entity: "111222333", company_profile: {} }));
    expect(e).toMatchObject({ errno: "23503", message: "entity 111222333 does not exist (bootstrap_entity creates it)" });
  });
});

describe("the shape check (CHECK constraint, every write path)", () => {
  const refused: [profile: unknown, message: string][] = [
    [[], "company_profile must be a JSON object {address, contact, bankAccounts}"],
    [{ name: "x" }, "company_profile: unknown key name; allowed: address, contact, bankAccounts"],
    [{ address: "Oslo" }, "company_profile.address must be an object with street, number, city, postalCode, country"],
    [{ address: { zip: "0155" } }, "company_profile.address: unknown key zip; allowed: street, number, city, postalCode, country"],
    [{ address: { city: 0 } }, "company_profile.address.city must be a non-empty string"],
    [{ address: { city: "  " } }, "company_profile.address.city must be a non-empty string"],
    [{ address: { country: "no" } }, "company_profile.address.country must be an ISO 3166-1 alpha-2 code (e.g. NO)"],
    [{ contact: { firstName: "Kari" } }, "company_profile.contact needs lastName"],
    [{ contact: { firstName: "Kari", lastName: "N", telephone: "1".repeat(19) } },
      "company_profile.contact.telephone is longer than 18 characters (SAF-T limit)"],
    [{ bankAccounts: {} }, "company_profile.bankAccounts must be an array of {number, ledgerAccount, currency}"],
    [{ bankAccounts: [{ number: "1" }] }, "company_profile.bankAccounts[0] needs ledgerAccount"],
    [{ bankAccounts: [PROFILE.bankAccounts[0], { number: "1", ledgerAccount: "19x0" }] },
      "company_profile.bankAccounts[1].ledgerAccount must be a 4-digit account code"],
    [{ bankAccounts: [{ number: "1", ledgerAccount: "1920", currency: "kr" }] },
      "company_profile.bankAccounts[0].currency must be an ISO 4217 code (e.g. NOK)"],
  ];
  for (const [profile, message] of refused) {
    test(JSON.stringify(profile), async () => {
      const e = await pgError(setProfile({ entity: E, company_profile: profile }));
      expect({ errno: e.errno, message: e.message }).toEqual({ errno: "P0001", message });
    });
  }

  test("a direct UPDATE as hovedbok_app is checked too; hovedbok_ro cannot set it", async () => {
    const e = await pgError(sql.begin(async (tx) => {
      await tx.unsafe("set local role hovedbok_app");
      await tx`update entity set company_profile = ${{ contact: {} }}::jsonb where orgnr = ${E}`;
    }));
    expect(e.message).toBe("company_profile.contact needs firstName");
    await sql.begin(async (tx) => {
      await tx.unsafe("set local role hovedbok_app");
      await tx`select set_company_profile(${{ entity: E, company_profile: PROFILE }}::jsonb)`;
    });
    const ro = await pgError(sql.begin(async (tx) => {
      await tx.unsafe("set local role hovedbok_ro");
      await tx`select set_company_profile(${{ entity: E, company_profile: {} }}::jsonb)`;
    }));
    expect(ro.errno).toBe("42501");
    expect(await stored()).toEqual(PROFILE);
  });
});
