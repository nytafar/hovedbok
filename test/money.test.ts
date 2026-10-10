// Ported from enkelt-regnskap test/expand.test.ts (money and VAT-rounding cases), 2026-10-10.
import { test, expect } from "bun:test";
import { divRoundHalfUp, formatDot, formatInput, formatKr, parseOre, parseOreOrNull, vatFromGross } from "../src/core/money";

test("parseOre and formatting", () => {
  expect(parseOre("1234.56")).toBe(123456);
  expect(parseOre("-1 234,5")).toBe(-123450);
  expect(parseOre("7")).toBe(700);
  expect(parseOre("-0.01")).toBe(-1);
  expect(parseOre("−12")).toBe(-1200); // Unicode minus
  expect(() => parseOre("1.234")).toThrow();
  expect(() => parseOre("abc")).toThrow();
  expect(formatDot(-528345)).toBe("-5283.45");
  expect(formatDot(5)).toBe("0.05");
  expect(formatKr(1818253)).toBe("18,182.53");
  expect(formatKr(-376261)).toBe("-3,762.61");
  expect(formatKr(5)).toBe("0.05");
  expect(formatKr(123456789)).toBe("1,234,567.89");
  expect(formatInput(-376261)).toBe("-3762.61");
  // en-GB input with thousands separators; Norwegian decimal comma (bank CSV) still accepted.
  expect(parseOre("1,234.56")).toBe(123456);
  expect(parseOre("-12,345")).toBe(-1234500);
  expect(parseOre("1,5")).toBe(150);
  expect(parseOre("2270,00")).toBe(227000);
  expect(() => parseOre("1,23,456")).toThrow();
});

test("parseOreOrNull: blank is null", () => {
  expect(parseOreOrNull(null)).toBeNull();
  expect(parseOreOrNull(undefined)).toBeNull();
  expect(parseOreOrNull("  ")).toBeNull();
  expect(parseOreOrNull("1,5")).toBe(150);
});

test("divRoundHalfUp rounds half up", () => {
  expect(divRoundHalfUp(5, 10)).toBe(1); // 0.5 -> 1
  expect(divRoundHalfUp(4, 10)).toBe(0);
  expect(divRoundHalfUp(15, 10)).toBe(2);
  expect(divRoundHalfUp(25, 10)).toBe(3);
  expect(() => divRoundHalfUp(-1, 10)).toThrow();
  expect(() => divRoundHalfUp(1, 0)).toThrow();
  expect(() => divRoundHalfUp(1.5, 10)).toThrow();
});

test("VAT from gross, 15 %: 5283.45 * 15/115 = 689.1456… -> 689.15", () => {
  expect(vatFromGross(528345, 15)).toBe(68915);
});

test("VAT from gross rounds in øre, half up", () => {
  // 0.03 kr incl. 25 %: 3*25/125 = 0.6 -> 1 øre
  expect(vatFromGross(3, 25)).toBe(1);
  // 0.11 kr: 11*25/125 = 2.2 -> 2; 0.13 kr: 13*25/125 = 2.6 -> 3
  expect(vatFromGross(11, 25)).toBe(2);
  expect(vatFromGross(13, 25)).toBe(3);
  // 1 øre * 15/115 = 0.13 -> 0
  expect(vatFromGross(1, 15)).toBe(0);
  // 6 øre * 25/125 = 1.2 -> 1
  expect(vatFromGross(6, 25)).toBe(1);
  // Exact half (not reachable at 15/25 %): 14 øre at 12 %: 168/112 = 1.5 -> 2
  expect(vatFromGross(14, 12)).toBe(2);
});

test("VAT from gross carries the sign of the amount (+debit/−credit)", () => {
  // Sale: gross −2270.00 credit at 25 % -> VAT −454.00 credit.
  expect(vatFromGross(-227000, 25)).toBe(-45400);
  // Rounding is on |amount|, so a negative half rounds away from zero like the positive one.
  expect(vatFromGross(-14, 12)).toBe(-2);
  expect(vatFromGross(-3, 25)).toBe(-1);
  expect(vatFromGross(12345, 0)).toBe(0);
  expect(Object.is(vatFromGross(-1, 15), -0)).toBe(false); // never −0
  expect(() => vatFromGross(100, -25)).toThrow();
  expect(() => vatFromGross(100.5, 25)).toThrow();
});
