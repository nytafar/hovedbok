// Ported from enkelt-regnskap test/korreksjon.test.ts ("dato: i dag i Europe/Oslo, terminfrister og lås") and
// test/expand.test.ts ("terminer"), 2026-10-10.
import { test, expect } from "bun:test";
import {
  addDays, deadlineFor, easterSunday, isBusinessDay, isLocked, isPublicHoliday, nextBusinessDay, osloDate,
  publicHolidays, today, vatTermDeadline, vatTermFor, vatTermPeriod,
} from "../src/core/date";

test("osloDate: calendar date in Europe/Oslo", () => {
  expect(osloDate(new Date("2026-10-01T22:30:00Z"))).toBe("2026-10-02"); // 00:30 in Oslo (summer time)
  expect(osloDate(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
  expect(osloDate(new Date("2026-10-01T21:00:00Z"))).toBe("2026-10-01");
});

test("today: HOVEDBOK_TODAY overrides only when well-formed", () => {
  const saved = process.env.HOVEDBOK_TODAY;
  try {
    process.env.HOVEDBOK_TODAY = "2026-10-13";
    expect(today()).toBe("2026-10-13");
    process.env.HOVEDBOK_TODAY = "13.10.2026";
    expect(today()).toBe(osloDate(new Date()));
  } finally {
    if (saved === undefined) delete process.env.HOVEDBOK_TODAY;
    else process.env.HOVEDBOK_TODAY = saved;
  }
});

test("addDays", () => {
  expect(addDays("2026-07-21", 7)).toBe("2026-07-28");
  expect(addDays("2026-12-30", 5)).toBe("2027-01-04");
  expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
});

test("VAT term 1 2026 deadline is 2026-04-10 (Friday, no roll)", () => {
  expect(vatTermDeadline(2026, 1)).toBe("2026-04-10");
});

test("VAT term deadlines (skatteforvaltningsforskriften § 8-3-10) with weekend/holiday roll", () => {
  // 10 October 2026 is a Saturday: deadline moves to Monday 12 October. 10 April 2027 is also a Saturday.
  expect([1, 2, 3, 4, 5, 6].map((t) => vatTermDeadline(2026, t))).toEqual(
    ["2026-04-10", "2026-06-10", "2026-08-31", "2026-10-12", "2026-12-10", "2027-02-10"],
  );
  expect(vatTermDeadline(2027, 1)).toBe("2027-04-12");
  expect(() => vatTermDeadline(2026, 0)).toThrow();
  expect(() => vatTermDeadline(2026, 7)).toThrow();
  expect(deadlineFor("2026-08-05")).toEqual({ year: 2026, term: 4, deadline: "2026-10-12" });
});

test("isLocked: locked from the day after the deadline", () => {
  expect(isLocked("2026-08-05", "2026-10-10")).toBe(false);
  expect(isLocked("2026-08-05", "2026-10-12")).toBe(false); // the deadline day itself is still open
  expect(isLocked("2026-08-05", "2026-10-13")).toBe(true);
  expect(isLocked("2026-06-30", "2026-10-01")).toBe(true); // term 3, deadline 31 August
  expect(isLocked("2026-09-01", "2026-12-10")).toBe(false);
});

test("Norwegian public holidays (lov om helligdager § 2) from the Easter computus", () => {
  // Easter 2026 is 5 April; 1/17 May, Ascension, Whitsun, Christmas.
  expect([...publicHolidays(2026)].sort()).toEqual([
    "2026-01-01", "2026-04-02", "2026-04-03", "2026-04-05", "2026-04-06", "2026-05-01", "2026-05-14", "2026-05-17",
    "2026-05-24", "2026-05-25", "2026-12-25", "2026-12-26",
  ]);
  // Easter 2027 is 28 March.
  for (const d of ["2027-03-25", "2027-03-26", "2027-03-28", "2027-03-29", "2027-05-06", "2027-05-17"]) {
    expect(publicHolidays(2027).has(d)).toBe(true);
  }
  expect(easterSunday(2024)).toBe("2024-03-31");
  expect(easterSunday(2025)).toBe("2025-04-20");
  expect(easterSunday(2026)).toBe("2026-04-05");
  expect(easterSunday(2038)).toBe("2038-04-25"); // latest possible
  expect(easterSunday(2285)).toBe("2285-03-22"); // earliest possible
  expect(isPublicHoliday("2026-05-17")).toBe(true);
  expect(isPublicHoliday("2026-05-18")).toBe(false);
});

test("business days roll past weekends and holidays", () => {
  expect(nextBusinessDay("2026-12-25")).toBe("2026-12-28"); // Friday Christmas Day -> Saturday, Sunday -> Monday 28th
  expect(nextBusinessDay("2026-05-14")).toBe("2026-05-15"); // Ascension (Thursday) -> Friday
  expect(nextBusinessDay("2026-04-02")).toBe("2026-04-07"); // Maundy Thursday -> Easter Tuesday
  expect(nextBusinessDay("2026-04-10")).toBe("2026-04-10");
  expect(isBusinessDay("2026-05-17")).toBe(false);
  expect(isBusinessDay("2026-10-10")).toBe(false); // Saturday
});

test("VAT terms", () => {
  expect(vatTermFor("2026-07-15")).toBe(4);
  expect(vatTermFor("2026-01-01")).toBe(1);
  expect(vatTermFor("2026-12-31")).toBe(6);
  expect(vatTermPeriod(2026, 4)).toEqual({ from: "2026-07-01", to: "2026-08-31" });
  expect(vatTermPeriod(2026, 1)).toEqual({ from: "2026-01-01", to: "2026-02-28" });
  expect(vatTermPeriod(2028, 1)).toEqual({ from: "2028-01-01", to: "2028-02-29" });
});
