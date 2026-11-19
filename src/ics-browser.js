/* Expands an ICS calendar into event instances inside the browser (HTML version).
   Uses ical.js (global ICAL), which understands Outlook's time zones and repeats. */
(function (root) {
  function expandIcs(text, rangeStart, rangeEnd) {
    const ICAL = root.ICAL;
    const cal = new ICAL.Component(ICAL.parse(text));

    cal.getAllSubcomponents('vtimezone').forEach((tzc) => {
      try {
        const tz = new ICAL.Timezone(tzc);
        if (tz.tzid && !ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(tz.tzid, tz);
      } catch (e) { /* ignore broken zone */ }
    });

    const masters = new Map();
    const exceptions = [];
    for (const vev of cal.getAllSubcomponents('vevent')) {
      if (vev.hasProperty('recurrence-id')) exceptions.push(vev);
      else masters.set(vev.getFirstPropertyValue('uid') + '|' + masters.size, vev);
    }
    const byUid = new Map();
    const events = [];
    for (const vev of masters.values()) {
      const ev = new ICAL.Event(vev);
      events.push(ev);
      if (!byUid.has(ev.uid)) byUid.set(ev.uid, ev);
    }
    const orphans = [];
    for (const exc of exceptions) {
      const e = new ICAL.Event(exc);
      const master = byUid.get(e.uid);
      if (master && master.isRecurring()) master.relateException(e);
      else orphans.push(e);
    }

    const out = [];
    const cancelled = (comp) => String(comp.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED';
    const add = (item, start, end, idBase) => {
      const s = start.toJSDate();
      const e = end ? end.toJSDate() : new Date(s.getTime() + (start.isDate ? 86400000 : 3600000));
      if (e <= rangeStart || s > rangeEnd) return;
      out.push({
        id: `${idBase}-${s.getTime()}`,
        title: item.summary || '(No title)',
        location: item.location || '',
        start: s.toISOString(),
        end: e.toISOString(),
        allDay: !!start.isDate,
        source: 'outlook'
      });
    };

    for (const ev of events) {
      if (cancelled(ev.component)) continue;
      if (!ev.isRecurring()) { add(ev, ev.startDate, ev.endDate, ev.uid); continue; }
      const it = ev.iterator();
      let next, guard = 0;
      while ((next = it.next()) && guard++ < 20000) {
        const jsStart = next.toJSDate();
        if (jsStart > rangeEnd) break;
        if (jsStart < new Date(rangeStart.getTime() - 40 * 86400000)) continue;
        const d = ev.getOccurrenceDetails(next);
        if (d.item !== ev && cancelled(d.item.component)) continue;
        add(d.item, d.startDate, d.endDate, ev.uid);
      }
    }
    for (const e of orphans) if (!cancelled(e.component)) add(e, e.startDate, e.endDate, e.uid + '-x');

    out.sort((a, b) => new Date(a.start) - new Date(b.start));
    return out;
  }
  root.DayBriefICS = { expandIcs };
})(typeof window !== 'undefined' ? window : globalThis);
