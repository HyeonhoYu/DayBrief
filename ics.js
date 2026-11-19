// Fetches a published Outlook / Google / iCloud calendar (ICS link) and
// expands it into a flat list of event instances for a date window.
const ical = require('node-ical');

function normalizeUrl(url) {
  url = (url || '').trim();
  if (url.startsWith('webcal://')) url = 'https://' + url.slice(9);
  return url;
}

async function fetchIcsText(url) {
  const res = await fetch(normalizeUrl(url), {
    headers: { 'User-Agent': 'DayBrief/1.0' },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`Calendar link returned HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) {
    throw new Error('That link did not return a calendar (ICS) file.');
  }
  return text;
}

// rrule.js (used by node-ical) returns instances for time-zoned rules so that
// their UTC fields hold the wall-clock time in the *computer's* own zone.
// Reading those fields back as local time gives the true instant.
function fromRruleLocal(r) {
  return new Date(r.getUTCFullYear(), r.getUTCMonth(), r.getUTCDate(),
    r.getUTCHours(), r.getUTCMinutes(), r.getUTCSeconds());
}

function expandEvents(text, rangeStart, rangeEnd) {
  const data = ical.sync.parseICS(text);
  const out = [];

  for (const key of Object.keys(data)) {
    const ev = data[key];
    if (!ev || ev.type !== 'VEVENT' || !ev.start) continue;
    if (ev.status && String(ev.status).toUpperCase() === 'CANCELLED') continue;

    const allDay = ev.datetype === 'date' || ev.start.dateOnly === true;
    const baseStart = new Date(ev.start);
    const baseEnd = ev.end ? new Date(ev.end) : new Date(baseStart.getTime() + (allDay ? 86400000 : 3600000));
    const duration = Math.max(0, baseEnd - baseStart);

    const push = (start, src) => {
      const end = new Date(start.getTime() + duration);
      if (end < rangeStart || start > rangeEnd) return;
      out.push({
        id: `${ev.uid || key}-${start.getTime()}`,
        title: String((src.summary && (src.summary.val || src.summary)) || '(No title)'),
        location: src.location ? String(src.location.val || src.location) : '',
        start: start.toISOString(),
        end: end.toISOString(),
        allDay,
        source: 'outlook'
      });
    };

    if (ev.rrule) {
      const tz = (ev.rrule.options && ev.rrule.options.tzid) || (ev.start && ev.start.tz) || null;
      const pad = rangeStart.getTime() - duration - 2 * 86400000;
      const instances = ev.rrule.between(new Date(pad), new Date(rangeEnd.getTime() + 2 * 86400000), true);
      const exTimes = Object.values(ev.exdate || {}).map(d => new Date(d).getTime());
      const ovTimes = Object.values(ev.recurrences || {})
        .filter(r => r.recurrenceid).map(r => new Date(r.recurrenceid).getTime());
      const skip = (inst) => {
        const t = inst.getTime();
        if (allDay) {
          const k = inst.toDateString();
          return [...exTimes, ...ovTimes].some(x => new Date(x).toDateString() === k);
        }
        return exTimes.some(x => Math.abs(x - t) < 60000) || ovTimes.some(x => Math.abs(x - t) < 60000);
      };

      for (const raw of instances) {
        const r = new Date(raw);
        let inst;
        if (allDay) {
          inst = new Date(r.getUTCFullYear(), r.getUTCMonth(), r.getUTCDate());
        } else if (tz) {
          inst = fromRruleLocal(r);
        } else {
          inst = r;
        }
        if (skip(inst)) continue;
        push(inst, ev);
      }
      for (const ov of Object.values(ev.recurrences || {})) {
        if (!ov.start) continue;
        if (ov.status && String(ov.status).toUpperCase() === 'CANCELLED') continue;
        const s = new Date(ov.start);
        const e = ov.end ? new Date(ov.end) : new Date(s.getTime() + duration);
        if (e < rangeStart || s > rangeEnd) continue;
        out.push({
          id: `${ev.uid || key}-ov-${s.getTime()}`,
          title: String((ov.summary && (ov.summary.val || ov.summary)) || ev.summary || '(No title)'),
          location: ov.location ? String(ov.location.val || ov.location) : '',
          start: s.toISOString(),
          end: e.toISOString(),
          allDay,
          source: 'outlook'
        });
      }
    } else if (!ev.recurrenceid) {
      push(baseStart, ev);
    }
  }

  out.sort((a, b) => new Date(a.start) - new Date(b.start));
  return out;
}

async function loadCalendar(url, daysBack = 35, daysAhead = 100) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysAhead, 23, 59, 59);
  const text = await fetchIcsText(url);
  return expandEvents(text, start, end);
}

module.exports = { loadCalendar, expandEvents, normalizeUrl };
