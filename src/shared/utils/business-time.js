// Business-day helpers. The app serves Indonesian businesses, so "today", "yesterday" and "the
// 07:00 digest" mean Western Indonesia Time (WIB, UTC+7 — no daylight saving), regardless of the
// server's own clock: the VPS and the MariaDB container both run in UTC, so a naive
// `new Date().toISOString().slice(0, 10)` is a day behind between 00:00 and 07:00 WIB.
//
// Timestamps stored by the database (DATETIME columns) are UTC; use the offsets below with
// CONVERT_TZ() to bucket them by business day.

export const BUSINESS_TZ = 'Asia/Jakarta';
export const DB_UTC_OFFSET = '+00:00';
export const BUSINESS_UTC_OFFSET = '+07:00';

const DAY_MS = 24 * 60 * 60 * 1000;

function partsInBusinessZone(date) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  });
  return Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
}

// 'YYYY-MM-DD' of the business day `date` falls on.
export function businessDate(date = new Date()) {
  const { year, month, day } = partsInBusinessZone(date);
  return `${year}-${month}-${day}`;
}

// 0-23, the hour of day in the business time zone.
export function businessHour(date = new Date()) {
  return Number(partsInBusinessZone(date).hour);
}

// Calendar arithmetic on a plain 'YYYY-MM-DD' (no time zone involved).
export function addDays(isoDate, days) {
  return new Date(new Date(`${isoDate}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}
