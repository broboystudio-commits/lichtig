// Jewish calendar helpers: Hebrew date, Shabbos / Yom Tov closing, and music-restricted periods.

import { HDate, HebrewCalendar, Location, months } from '@hebcal/core';

export const CITIES = [
  'New York',
  'Jerusalem',
  'London',
  'Los Angeles',
  'Chicago',
  'Miami',
  'Montreal',
  'Toronto',
  'Antwerp',
  'Manchester',
  'Paris',
  'Melbourne',
  'Johannesburg',
  'Buenos Aires',
];

const cache = new Map();

/**
 * Is the site closed right now for Shabbos or Yom Tov in `city`?
 * Closed from candle lighting until havdalah (Shabbos, Yom Tov and Yom Kippur).
 */
export function closedStatus(city, now = new Date()) {
  const loc = Location.lookup(city) || Location.lookup('New York');
  const key = loc.getName() + ':' + Math.floor(now.getTime() / 600000); // recompute every 10 min
  if (cache.has(key)) return cache.get(key);

  const events = HebrewCalendar.calendar({
    start: new Date(now.getTime() - 3 * 864e5),
    end: new Date(now.getTime() + 9 * 864e5),
    location: loc,
    candlelighting: true,
    il: loc.getIsrael(),
  })
    .filter((e) => e.eventTime && /^(Candle lighting|Havdalah)/.test(e.getDesc()))
    .map((e) => ({ type: e.getDesc().startsWith('Havdalah') ? 'havdalah' : 'candles', at: e.eventTime }))
    .sort((a, b) => a.at - b.at);

  let closed = false;
  let reopensAt = null;
  const lastCandles = [...events].reverse().find((e) => e.type === 'candles' && e.at <= now);
  if (lastCandles) {
    const havdalahAfter = events.find((e) => e.type === 'havdalah' && e.at > lastCandles.at);
    if (havdalahAfter && havdalahAfter.at > now) {
      closed = true;
      reopensAt = havdalahAfter.at;
    }
  }
  const nextCandles = events.find((e) => e.type === 'candles' && e.at > now);
  const result = {
    closed,
    city: loc.getName(),
    tzid: loc.getTzid(),
    reopensAt: reopensAt ? reopensAt.getTime() : null,
    nextCandleLighting: nextCandles ? nextCandles.at.getTime() : null,
  };
  if (cache.size > 50) cache.clear();
  cache.set(key, result);
  return result;
}

export function hebrewDate(now = new Date()) {
  const hd = new HDate(now);
  return { he: hd.renderGematriya(true), en: hd.render('en') };
}

/**
 * Days when many communities avoid music: Sefirah (16 Nisan to 5 Sivan, except Lag BaOmer)
 * and the Three Weeks (17 Tammuz to 10 Av).
 */
export function musicPeriod(now = new Date()) {
  const hd = new HDate(now);
  const m = hd.getMonth();
  const d = hd.getDate();
  if ((m === months.NISAN && d >= 16) || (m === months.IYYAR && d !== 18) || (m === months.SIVAN && d <= 5)) {
    return 'sefirah';
  }
  if ((m === months.TAMUZ && d >= 17) || (m === months.AV && d <= 10)) return 'three_weeks';
  return null;
}
