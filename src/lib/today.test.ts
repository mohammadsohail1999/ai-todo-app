import { describe, expect, it } from "vitest";
import { isValidTimeZone, todayInTimeZone } from "./today";

describe("todayInTimeZone", () => {
  it("gives the local date, not the UTC date, at 1 AM in Asia/Kolkata", () => {
    // 1 AM on 15 March in Kolkata is still 14 March in UTC.
    const now = new Date("2026-03-14T19:30:00Z");
    expect(todayInTimeZone("Asia/Kolkata", now)).toBe("2026-03-15");
    expect(todayInTimeZone("UTC", now)).toBe("2026-03-14");
  });

  it("gives an earlier date west of UTC", () => {
    const now = new Date("2026-03-15T03:00:00Z");
    expect(todayInTimeZone("America/Los_Angeles", now)).toBe("2026-03-14");
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA names and rejects anything else", () => {
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });
});
