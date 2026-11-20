// "Today" is a plain YYYY-MM-DD string for the user's timezone, so queries never do timezone math.

export function isValidTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Throws RangeError on an invalid timezone, so check it with isValidTimeZone first.
export function todayInTimeZone(timeZone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const part = (type: "year" | "month" | "day") =>
    parts.find((p) => p.type === type)!.value;

  return `${part("year")}-${part("month")}-${part("day")}`;
}
