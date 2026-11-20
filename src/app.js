/* DayBrief renderer. Plain JS, no build step. */
(() => {
  const hasApi = !!window.api;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  let state = null;
  let taskFilter = 'open';
  let popupOn = false;

  // ---------- helpers ----------
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const pad = (n) => String(n).padStart(2, '0');
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const todayKey = () => keyOf(new Date());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const diffDays = (aKey, bKey) => Math.round((fromKey(bKey) - fromKey(aKey)) / 86400000);
  const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

  const URL_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/i;
  function normalizeLink(v) {
    v = String(v || '').trim();
    if (!v) return '';
    if (/^www\./i.test(v)) v = 'https://' + v;
    if (!/^https?:\/\//i.test(v)) {
      if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(v)) v = 'https://' + v; else return '';
    }
    try { return new URL(v).href; } catch (e) { return ''; }
  }
  function linkLabel(href) {
    try { return new URL(href).hostname.replace(/^www\./, ''); } catch (e) { return 'Open link'; }
  }
  // Pull a pasted URL out of a task title: "Grade essays https://canvas..." -> title + link
  function splitTitleLink(title) {
    const m = String(title).match(URL_RE);
    if (!m) return { title: String(title).trim(), link: '' };
    const link = normalizeLink(m[0].replace(/[).,;]+$/, ''));
    let rest = String(title).replace(m[0], '').replace(/\s{2,}/g, ' ').trim().replace(/[-:|]\s*$/, '').trim();
    if (!rest) rest = linkLabel(link);
    return { title: rest, link };
  }

  function linkify(text) {
    const safe = esc(text);
    return safe.replace(/(https?:\/\/[^\s<]+)/g, (u) => {
      const label = /teams\.microsoft/.test(u) ? 'Join Teams' : /zoom\.us/.test(u) ? 'Join Zoom' : 'Open link';
      return `<a href="#" data-url="${u}">${label}</a>`;
    });
  }

  const CAT_SRC = {
    sit: 'img/sit.webp', hero: 'img/hero.webp', jump: 'img/jump.webp', stretch: 'img/stretch.webp',
    eat: 'img/eat.webp', fly: 'img/fly.webp', victory: 'img/victory.webp', alert: 'img/alert.webp'
  };
  const catImg = (name, cls = '') => `<img class="${cls}" src="${CAT_SRC[name]}" alt="" />`;
  const catEmpty = (name, msg, small) => `<li class="empty-cat ${small ? 'small' : ''}">${catImg(name)}<span>${msg}</span></li>`;

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------- storage ----------
  async function load() {
    if (hasApi) return window.api.load();
    try {
      const raw = localStorage.getItem('daybrief');
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    if (location.hash === '#demo') return demoData();
    return { todos: [], meetings: [], occasions: [], outlook: { events: [] },
      settings: { name: '', icsUrl: '', popupDaily: true, meetingReminderMin: 10, occasionLeadDays: 14 } };
  }

  let saveTimer = null;
  // ---------- cross-computer sync (HTML version, via the Google bridge) ----------
  const syncedData = () => ({
    todos: state.todos, meetings: state.meetings, occasions: state.occasions, notes: state.notes || '',
    profile: { name: state.settings.name || '', occasionLeadDays: state.settings.occasionLeadDays, meetingReminderMin: state.settings.meetingReminderMin }
  });
  const fingerprint = () => JSON.stringify(syncedData());
  let lastFp = null;
  let pushTimer = null;

  function save() {
    if (state && lastFp !== null) {
      const fp = fingerprint();
      if (fp !== lastFp) {
        lastFp = fp;
        state.updatedAt = Date.now();
        if (!hasApi && state.settings.syncOn) { clearTimeout(pushTimer); pushTimer = setTimeout(() => pushRemote(), 2500); }
      }
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (hasApi) window.api.save(state);
      else { try { localStorage.setItem('daybrief', JSON.stringify(state)); } catch (e) { /* ignore */ } }
    }, 150);
  }

  // ---------- events ----------
  function manualToEvent(m) {
    const d = fromKey(m.date);
    let start, end, allDay = !m.time;
    if (m.time) {
      const [h, mi] = m.time.split(':').map(Number);
      start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, mi);
      if (m.endTime) {
        const [eh, emi] = m.endTime.split(':').map(Number);
        end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), eh, emi);
      } else end = new Date(start.getTime() + 60 * 60000);
    } else {
      start = d; end = addDays(d, 1);
    }
    return { id: m.id, title: m.title, location: m.location || '', start, end, allDay, source: 'manual' };
  }

  function eventsOn(key) {
    const dayStart = fromKey(key), dayEnd = addDays(dayStart, 1);
    const outlook = (state.outlook?.events || []).map(e => ({ ...e, start: new Date(e.start), end: new Date(e.end) }));
    const manual = (state.meetings || []).map(manualToEvent);
    return [...outlook, ...manual]
      .filter(e => e.start < dayEnd && e.end > dayStart && !(e.allDay && e.end <= dayStart))
      .sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start));
  }

  // ---------- occasions ----------
  // ---------- Korea time & Korean lunar calendar ----------
  const KST = 'Asia/Seoul';
  function keyInZone(tz, d = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(d).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  const koreaTodayKey = () => keyInZone(KST);
  const baseKeyFor = (o) => (o.kst ? koreaTodayKey() : todayKey());

  let lunarFmt = null;
  function getLunarFmt() {
    if (lunarFmt !== null) return lunarFmt;
    try {
      lunarFmt = new Intl.DateTimeFormat('en-u-ca-dangi', { timeZone: 'UTC', month: 'numeric', day: 'numeric' });
      if (!/dangi|chinese/.test(lunarFmt.resolvedOptions().calendar)) {
        lunarFmt = new Intl.DateTimeFormat('en-u-ca-chinese', { timeZone: 'UTC', month: 'numeric', day: 'numeric' });
      }
      if (!/dangi|chinese/.test(lunarFmt.resolvedOptions().calendar)) lunarFmt = false;
    } catch (e) { lunarFmt = false; }
    return lunarFmt;
  }
  const lunarYearCache = new Map();
  function lunarDaysOfYear(y) {
    if (lunarYearCache.has(y)) return lunarYearCache.get(y);
    const f = getLunarFmt(), out = [];
    if (f) {
      for (let d = new Date(y, 0, 1); d.getFullYear() === y; d = addDays(d, 1)) {
        const parts = f.formatToParts(new Date(Date.UTC(y, d.getMonth(), d.getDate(), 12)));
        const mp = parts.find(p => p.type === 'month').value;
        const dp = parts.find(p => p.type === 'day').value;
        out.push({ date: d, m: parseInt(mp, 10), leap: mp.replace(/^\d+/, '') !== '', d: parseInt(dp, 10) });
      }
    }
    lunarYearCache.set(y, out);
    return out;
  }
  // Solar dates in year y that match a lunar month/day (Korean calendar).
  function lunarSolarDates(o, y) {
    const days = lunarDaysOfYear(y);
    const pick = (leap) => {
      const exact = days.filter(x => x.m === o.month && x.leap === leap && x.d === o.day);
      if (exact.length) return exact.map(x => x.date);
      if (o.day === 30) { // that month has only 29 days this year: use its last day
        return days.filter((x, i) => x.m === o.month && x.leap === leap && x.d === 29 && (!days[i + 1] || days[i + 1].d === 1)).map(x => x.date);
      }
      return [];
    };
    let r = pick(!!o.leap);
    if (!r.length && o.leap) r = pick(false); // no leap month this year
    return r;
  }

  function nextOccurrence(o) {
    const today = fromKey(baseKeyFor(o));
    let d;
    if (o.lunar) {
      const y = today.getFullYear();
      d = [...lunarSolarDates(o, y), ...lunarSolarDates(o, y + 1)].find(x => x >= today);
      if (!d) return { date: addDays(today, 999), days: 999, years: null };
    } else {
      const make = (y) => {
        const m = o.month - 1;
        const last = new Date(y, m + 1, 0).getDate();
        return new Date(y, m, Math.min(o.day, last));
      };
      d = make(today.getFullYear());
      if (d < today) d = make(today.getFullYear() + 1);
    }
    const days = Math.round((d - today) / 86400000);
    const years = o.year ? d.getFullYear() - Number(o.year) : null;
    return { date: d, days, years };
  }

  const lunarText = (o) => `Lunar ${o.leap ? 'leap ' : ''}${o.month}/${o.day}`;

  function occasionLabel(o, n) {
    if (o.type === 'birthday') return n.years != null && n.years > 0 ? `Turns ${n.years}` : 'Birthday';
    if (o.type === 'anniversary') return n.years != null && n.years > 0 ? `${ordinal(n.years)} anniversary` : 'Anniversary';
    return n.years != null && n.years > 0 ? `${ordinal(n.years)} year` : 'Yearly';
  }

  const ddayText = (days) => days === 0 ? 'Today' : days === 1 ? 'D-1' : `D-${days}`;

  function sortedOccasions() {
    return (state.occasions || []).map(o => ({ o, n: nextOccurrence(o) })).sort((a, b) => a.n.days - b.n.days);
  }

  // ---------- tasks ----------
  const prioRank = { high: 0, normal: 1, low: 2 };
  function taskBucket(t) {
    if (!t.due) return 'nodate';
    const d = diffDays(todayKey(), t.due);
    if (d < 0) return 'overdue';
    if (d === 0) return 'today';
    if (d === 1) return 'tomorrow';
    if (d <= 7) return 'week';
    return 'later';
  }
  function dueText(t) {
    if (!t.due) return '';
    const d = diffDays(todayKey(), t.due);
    if (d < 0) return d === -1 ? 'Yesterday' : `${-d} days late`;
    if (d === 0) return 'Today';
    if (d === 1) return 'Tomorrow';
    const dt = fromKey(t.due);
    return d <= 6 ? dt.toLocaleDateString([], { weekday: 'short' }) : dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  const sortTasks = (a, b) => (prioRank[a.priority] ?? 1) - (prioRank[b.priority] ?? 1) || (a.due || '9999').localeCompare(b.due || '9999') || (a.createdAt || 0) - (b.createdAt || 0);

  function taskItem(t) {
    const b = taskBucket(t);
    const li = document.createElement('li');
    li.className = 'task' + (t.done ? ' done' : '');
    li.dataset.id = t.id;
    li.innerHTML = `
      <input type="checkbox" ${t.done ? 'checked' : ''} aria-label="Mark done" />
      <span class="prio ${esc(t.priority)}" title="${esc(t.priority)} priority"></span>
      <span class="title" tabindex="0" title="Click to edit">${esc(t.title)}</span>
      ${t.link ? `<a class="task-link" href="#" data-url="${esc(t.link)}" title="${esc(t.link)}">${esc(linkLabel(t.link))} &#8599;</a>` : ''}
      <span class="meta ${!t.done && b === 'overdue' ? 'overdue' : ''} ${!t.done && b === 'today' ? 'today' : ''}">${esc(dueText(t))}</span>
      <button class="x" title="Delete" aria-label="Delete task">&times;</button>`;
    return li;
  }

  function addTask(form) {
    const f = new FormData(form);
    const raw = String(f.get('title') || '').trim();
    if (!raw) return;
    const { title, link } = splitTitleLink(raw);
    state.todos.push({ id: uid(), title, link, due: f.get('due') || '', priority: f.get('priority') || 'normal', done: false, createdAt: Date.now() });
    form.reset();
    form.querySelector('input[name=title]').focus();
    save(); render();
  }

  function startEditTask(li) {
    const t = state.todos.find(x => x.id === li.dataset.id);
    if (!t || li.querySelector('.title-edit')) return;
    const span = li.querySelector('.title');
    const meta = li.querySelector('.meta');
    const wrap = document.createElement('span');
    wrap.className = 'title-edit row';
    wrap.innerHTML = `<input class="te-title" value="${esc(t.title)}" style="flex:1" />
      <input class="te-due" type="date" value="${esc(t.due)}" />
      <select class="te-prio"><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select>
      <input class="te-link" type="url" placeholder="Link (optional): paste a web address" value="${esc(t.link || '')}" />`;
    wrap.querySelector('.te-prio').value = t.priority || 'normal';
    span.replaceWith(wrap); meta.hidden = true;
    const oldLink = li.querySelector('.task-link'); if (oldLink) oldLink.hidden = true;
    const input = wrap.querySelector('.te-title');
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
    const commit = () => {
      const sp = splitTitleLink(input.value);
      if (sp.title) t.title = sp.title;
      const typed = wrap.querySelector('.te-link').value.trim();
      t.link = typed ? normalizeLink(typed) : sp.link;
      t.due = wrap.querySelector('.te-due').value;
      t.priority = wrap.querySelector('.te-prio').value;
      save(); render();
    };
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') render();
    });
    wrap.addEventListener('focusout', () => setTimeout(() => { if (!wrap.contains(document.activeElement)) commit(); }, 0));
  }

  // ---------- render: today ----------
  function evItem(e, now, compact) {
    const li = document.createElement('li');
    const past = !e.allDay && e.end < now;
    const live = !e.allDay && e.start <= now && e.end > now;
    li.className = `ev ${e.source === 'manual' ? 'manual' : ''} ${past ? 'past' : ''} ${live ? 'now' : ''}`;
    const time = e.allDay ? 'All day' : fmtTime(e.start);
    const endT = e.allDay || compact ? '' : `<small>${fmtTime(e.end)}</small>`;
    li.innerHTML = `
      <div class="t">${time}${endT}</div>
      <div><div class="ttl">${esc(e.title)}${live ? '<span class="badge-now">Now</span>' : ''}</div>
        ${e.location && !compact ? `<div class="loc">${linkify(e.location)}</div>` : ''}</div>
      ${e.source === 'manual' ? `<button class="x" data-del-meeting="${esc(e.id)}" title="Remove" aria-label="Remove meeting">&times;</button>` : '<span></span>'}`;
    return li;
  }

  function renderToday() {
    const now = new Date();
    const tk = todayKey();
    const hour = now.getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const name = state.settings.name ? `, ${state.settings.name}` : '';
    $('#todayEyebrow').textContent = `${greet}${name}`;
    $('#todayTitle').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

    const todays = eventsOn(tk);
    const timed = todays.filter(e => !e.allDay);
    const upcoming = timed.filter(e => e.end > now);
    const open = state.todos.filter(t => !t.done);
    const dueNow = open.filter(t => ['overdue', 'today'].includes(taskBucket(t)));
    const overdue = open.filter(t => taskBucket(t) === 'overdue');
    const occ = sortedOccasions();
    const lead = Number(state.settings.occasionLeadDays) || 14;
    const soonOcc = occ.filter(x => x.n.days <= lead);

    // chips
    const next = upcoming[0];
    $('#todayChips').innerHTML = [
      `<span class="chip"><b>${timed.length}</b> meeting${timed.length === 1 ? '' : 's'}</span>`,
      `<span class="chip"><b>${dueNow.length}</b> due today${overdue.length ? ` (${overdue.length} late)` : ''}</span>`,
      next ? `<span class="chip">Next: <b>${esc(fmtTime(next.start))}</b> ${esc(next.title.slice(0, 28))}</span>` : '',
      state.settings.koreaClock !== false ? `<span class="chip korea">Korea <b>${esc(now.toLocaleString('en-US', { timeZone: KST, weekday: 'short', hour: 'numeric', minute: '2-digit' }))}</b></span>` : ''
    ].join('');

    // banner for today's occasions
    const todayOcc = occ.filter(x => x.n.days === 0);
    const banner = $('#occasionBanner');
    if (todayOcc.length) {
      banner.hidden = false;
      banner.innerHTML = `${catImg('fly', 'banner-cat')}<div>Today: ${todayOcc.map(x => `<b>${esc(x.o.name)}</b> (${esc(occasionLabel(x.o, x.n))}${x.o.kst && keyOf(x.n.date) !== tk ? ', already the day in Korea' : ''})`).join(', ')}.${todayOcc.some(x => x.o.note) ? ' ' + todayOcc.filter(x => x.o.note).map(x => esc(x.o.note)).join(' · ') : ''}</div>`;
    } else banner.hidden = true;

    // schedule
    const ol = $('#todaySchedule'); ol.innerHTML = '';
    if (!todays.length) ol.innerHTML = catEmpty('stretch', (hasApi ? state.settings.icsUrl : state.settings.bridgeUrl) ? 'No meetings today. Time for a good stretch.' : 'No meetings yet. Connect Outlook in Settings or add one here.');
    todays.forEach(e => ol.appendChild(evItem(e, now)));

    const ol2 = $('#tomorrowSchedule'); ol2.innerHTML = '';
    let anyNext = false;
    for (let i = 1; i <= 7; i++) {
      const d = addDays(now, i);
      const evs = eventsOn(keyOf(d));
      if (!evs.length) continue;
      anyNext = true;
      const lab = document.createElement('li');
      lab.className = 'day-label';
      lab.textContent = i === 1 ? `Tomorrow, ${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}` : d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
      ol2.appendChild(lab);
      evs.forEach(e => ol2.appendChild(evItem(e, now, true)));
    }
    if (!anyNext) ol2.innerHTML = '<li class="empty">Nothing scheduled in the next 7 days.</li>';

    // tasks
    // Today box: overdue + due today, the most important list on the page
    const focus = open.filter(t => ['overdue', 'today'].includes(taskBucket(t)))
      .sort((a, b) => (taskBucket(a) === 'overdue' ? 0 : 1) - (taskBucket(b) === 'overdue' ? 0 : 1) || sortTasks(a, b));
    const doneToday = state.todos.filter(t => t.done && t.doneAt && keyOf(new Date(t.doneAt)) === tk);
    const fu = $('#todayFocus'); fu.innerHTML = '';
    if (!focus.length) {
      fu.innerHTML = catEmpty('eat', doneToday.length ? `All done for today (${doneToday.length} finished). Snack break earned.` : 'Nothing due today. Snack break earned.', true);
    }
    focus.forEach(t => fu.appendChild(taskItem(t)));
    $('#focusCount').textContent = focus.length
      ? `${focus.length} to do${overdue.length ? ` · ${overdue.length} late` : ''}${doneToday.length ? ` · ${doneToday.length} done` : ''}`
      : '';
    $('#focusBox').classList.toggle('has-late', overdue.length > 0);

    // Below the input: what was finished today
    const ul = $('#todayTasks'); ul.innerHTML = '';
    const label = (txt) => { const li = document.createElement('li'); li.className = 'list-label'; li.textContent = txt; ul.appendChild(li); };

    // Separate card: tasks with no due date (research, long-term work)
    const nodate = open.filter(t => taskBucket(t) === 'nodate').sort(sortTasks);
    const au = $('#anyTasks'); au.innerHTML = '';
    if (!nodate.length) au.innerHTML = '<li class="empty">Research and long-term tasks without a deadline live here.</li>';
    nodate.forEach(t => au.appendChild(taskItem(t)));
    $('#anyCount').textContent = nodate.length ? `${nodate.length} open` : '';

    // Notes: keep what's typed; never overwrite while typing
    const na = $('#notes');
    if (document.activeElement !== na && na.value !== (state.notes || '')) na.value = state.notes || '';
    if (doneToday.length) { label('Done today'); doneToday.forEach(t => ul.appendChild(taskItem(t))); }
    // coming up: next 7 days of tasks and hand-added meetings, plus birthdays and dates
    const ou = $('#todayOccasions'); ou.innerHTML = '';
    const upcoming7 = [];
    open.filter(t => t.due).forEach(t => {
      const d = diffDays(tk, t.due);
      if (d >= 1 && d <= 7) upcoming7.push({ days: d, sort: d * 10000, kind: 'task', t });
    });
    (state.meetings || []).forEach(m => {
      const d = diffDays(tk, m.date);
      if (d >= 1 && d <= 7) {
        const mins = m.time ? Number(m.time.slice(0, 2)) * 60 + Number(m.time.slice(3, 5)) : 0;
        upcoming7.push({ days: d, sort: d * 10000 + mins, kind: 'meeting', m });
      }
    });
    soonOcc.forEach(x => upcoming7.push({ days: x.n.days, sort: x.n.days * 10000 - 1, kind: 'occ', x }));
    upcoming7.sort((a, b) => a.sort - b.sort);
    if (!upcoming7.length) {
      ou.innerHTML = catEmpty('sit', occ.length || open.length ? 'Nothing coming up in the next 7 days.' : 'Tasks with due dates, meetings and birthdays coming up will show here.', true);
    }
    upcoming7.forEach(it => ou.appendChild(it.kind === 'occ' ? occItem(it.x, false) : upcomingItem(it)));
    // popup bar text
    $('#popupGreeting').textContent = `${greet}${name}.`;
    const bits = [];
    bits.push(`${timed.length} meeting${timed.length === 1 ? '' : 's'}`);
    bits.push(`${dueNow.length} task${dueNow.length === 1 ? '' : 's'} due`);
    if (todayOcc.length) bits.push(`${todayOcc.map(x => x.o.name).join(', ')} today`);
    else if (soonOcc[0]) bits.push(`${soonOcc[0].o.name} in ${soonOcc[0].n.days} day${soonOcc[0].n.days === 1 ? '' : 's'}`);
    $('#popupSummary').textContent = `Today: ${bits.join(' · ')}.`;
  }

  function upcomingItem(it) {
    const li = document.createElement('li');
    li.className = `occ up-${it.kind}`;
    const when = addDays(new Date(), it.days).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    let title, sub, badge;
    if (it.kind === 'task') {
      const t = it.t;
      title = esc(t.title);
      sub = esc(when) + (t.priority === 'high' ? ' · high priority' : '') +
        (t.link ? ` · <a href="#" data-url="${esc(t.link)}">${esc(linkLabel(t.link))} &#8599;</a>` : '');
      badge = '<span class="kind task">Task</span>';
    } else {
      const m = it.m;
      title = esc(m.title);
      const time = m.time ? fmtTime(manualToEvent(m).start) : 'All day';
      sub = `${esc(when)} · ${esc(time)}` + (m.location ? ` · ${linkify(m.location)}` : '');
      badge = '<span class="kind meeting">Meeting</span>';
    }
    li.innerHTML = `
      <span class="dday">${ddayText(it.days)}</span>
      <span class="who"><b>${title}</b><span>${sub}</span></span>
      ${badge}`;
    return li;
  }

  function occItem({ o, n }, full) {
    const li = document.createElement('li');
    li.className = `occ ${n.days === 0 ? 'today' : n.days <= 3 ? 'soon' : ''}`;
    const when = n.date.toLocaleDateString([], { weekday: full ? undefined : 'short', month: 'short', day: 'numeric' });
    li.innerHTML = `
      <span class="dday">${ddayText(n.days)}</span>
      <span class="who"><b>${esc(o.name)}</b><span>${esc(occasionLabel(o, n))} · ${o.lunar ? esc(lunarText(o)) + ' = ' : ''}${esc(when)}${o.kst ? ' (Korea date)' : ''}${o.note ? ' · ' + esc(o.note) : ''}</span></span>
      <span class="kind ${esc(o.type)}">${o.type === 'birthday' ? 'Birthday' : o.type === 'anniversary' ? 'Anniv.' : 'Date'}</span>
      ${full ? `<button class="x" data-del-occ="${esc(o.id)}" title="Delete" aria-label="Delete date">&times;</button>` : ''}`;
    return li;
  }

  // ---------- AI news (updated daily by a scheduled Claude task) ----------
  const NEWS_URLS = [
    'https://raw.githubusercontent.com/HyeonhoYu/DayBrief/main/web/news.json',
    'https://hyeonhoyu.github.io/DayBrief/web/news.json'
  ];
  let newsBusy = false;
  async function loadNews() {
    if (newsBusy) return;
    newsBusy = true;
    try {
      for (const u of NEWS_URLS) {
        try {
          const res = await fetch(u + '?t=' + Math.floor(Date.now() / 600000), { cache: 'no-store' });
          if (!res.ok) continue;
          const data = await res.json();
          if (data && Array.isArray(data.items)) { state.news = data; save(); renderNews(); return; }
        } catch (e) { /* try the next address */ }
      }
    } finally { newsBusy = false; }
  }

  function renderNews() {
    const ul = $('#newsList'); if (!ul) return;
    const n = state.news;
    ul.innerHTML = '';
    if (!n || !n.items || !n.items.length) {
      ul.innerHTML = '<li class="empty">Today\'s AI stories will appear here each morning.</li>';
      $('#newsUpdated').textContent = '';
      return;
    }
    const upd = n.updated ? new Date(n.updated) : null;
    const stale = upd && (Date.now() - upd.getTime()) > 2 * 86400000;
    $('#newsUpdated').textContent = upd ? `${stale ? 'Last updated' : 'Updated'} ${upd.toLocaleDateString([], { month: 'short', day: 'numeric' })}` : '';
    const ko = state.settings.newsLang === 'ko';
    $$('.news-tools .seg button').forEach(b => b.classList.toggle('active', b.dataset.lang === (ko ? 'ko' : 'en')));
    n.items.slice(0, 8).forEach(it => {
      const href = normalizeLink(it.url);
      const title = ko && it.title_ko ? it.title_ko : it.title;
      const summary = ko && it.summary_ko ? it.summary_ko : (it.summary || '');
      const li = document.createElement('li');
      li.className = 'news-item';
      li.innerHTML = `
        ${it.tag ? `<span class="news-tag ${it.tag === 'Korea' ? 'korea' : ''}">${esc(it.tag)}</span>` : ''}
        <a class="news-title" href="#" ${href ? `data-url="${esc(href)}"` : ''}>${esc(title)}</a>
        <p>${esc(summary)}</p>
        <span class="news-src">${esc(it.source || (href ? linkLabel(href) : ''))}${it.published ? ' · ' + esc(it.published) : ''}</span>`;
      ul.appendChild(li);
    });
  }

  // ---------- render: tasks ----------
  function renderTasks() {
    const wrap = $('#taskGroups'); wrap.innerHTML = '';
    const open = state.todos.filter(t => !t.done);
    $('#taskCount').textContent = open.length || '';
    if (taskFilter === 'done') {
      const done = state.todos.filter(t => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
      const ul = document.createElement('ul'); ul.className = 'tasks';
      if (!done.length) ul.innerHTML = catEmpty('stretch', 'No finished tasks yet.');
      done.forEach(t => ul.appendChild(taskItem(t)));
      if (done.length) {
        const clear = document.createElement('button');
        clear.className = 'btn btn-ghost btn-sm'; clear.textContent = 'Clear finished tasks'; clear.style.marginTop = '12px';
        clear.onclick = () => { if (confirm('Delete all finished tasks?')) { state.todos = state.todos.filter(t => !t.done); save(); render(); } };
        wrap.append(ul, clear);
      } else wrap.append(ul);
      return;
    }
    const list = taskFilter === 'all' ? state.todos : open;
    const groups = [['overdue', 'Overdue'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'This week'], ['later', 'Later'], ['nodate', 'No date']];
    let any = false;
    for (const [k, label] of groups) {
      const items = list.filter(t => taskBucket(t) === k).sort((a, b) => (a.done - b.done) || sortTasks(a, b));
      if (!items.length) continue;
      any = true;
      const h = document.createElement('div'); h.className = `group-title ${k === 'overdue' ? 'overdue' : ''}`; h.innerHTML = `${k === 'overdue' && taskFilter !== 'done' ? catImg('alert', 'title-cat') : ''}${label} (${items.length})`;
      const ul = document.createElement('ul'); ul.className = 'tasks';
      items.forEach(t => ul.appendChild(taskItem(t)));
      wrap.append(h, ul);
    }
    if (!any) wrap.innerHTML = `<ul class="tasks">${catEmpty('hero', 'All clear. You saved the day!')}</ul>`;
  }

  // ---------- render: calendar (week / month) ----------
  const OUTLOOK_BACK = 35, OUTLOOK_AHEAD = 100;
  let calMode = 'week';
  let calAnchor = new Date();
  let calScrollReset = true;
  let evRegistry = new Map();
  const startOfWeek = (d) => addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -d.getDay());
  const shortTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(/\s?AM$/, 'a').replace(/\s?PM$/, 'p');
  const tasksDue = (k) => state.todos.filter(t => !t.done && t.due === k).sort(sortTasks);

  function occasionsOn(k) {
    const d = fromKey(k);
    return (state.occasions || []).filter(o => {
      if (o.lunar) return lunarSolarDates(o, d.getFullYear()).some(x => keyOf(x) === k);
      const last = new Date(d.getFullYear(), o.month, 0).getDate();
      return o.month - 1 === d.getMonth() && Math.min(o.day, last) === d.getDate();
    }).map(o => ({ o, n: { date: d, days: diffDays(baseKeyFor(o), k), years: o.year ? d.getFullYear() - Number(o.year) : null } }));
  }

  function reg(e) { const id = 'e' + evRegistry.size; evRegistry.set(id, e); return id; }
  const chipEv = (e, withTime) => `<button class="cal-chip ev ${e.source === 'manual' ? 'manual' : ''}" data-ev="${reg(e)}" title="${esc(e.title)}">${withTime && !e.allDay ? `<i>${esc(shortTime(e.start))}</i> ` : ''}${esc(e.title)}</button>`;
  const chipOcc = (x) => `<span class="cal-chip occ" title="${esc(occasionLabel(x.o, x.n))}">${esc(x.o.name)}: ${esc(occasionLabel(x.o, x.n))}</span>`;
  const chipTask = (t) => `<button class="cal-chip tsk" data-task="${esc(t.id)}" title="${esc(t.title)}"><span class="box"></span>${esc(t.title)}</button>`;

  function layoutDay(items) {
    items.sort((a, b) => a.s - b.s || b.en - a.en);
    let cluster = [], clusterEnd = 0, colsEnd = [];
    const flush = () => { const n = Math.max(...cluster.map(c => c.col)) + 1; cluster.forEach(c => { c.ncols = n; }); cluster = []; colsEnd = []; };
    for (const it of items) {
      if (cluster.length && it.s >= clusterEnd) flush();
      let c = colsEnd.findIndex(end => end <= it.s);
      if (c < 0) { c = colsEnd.length; colsEnd.push(0); }
      colsEnd[c] = it.en; it.col = c; cluster.push(it);
      clusterEnd = Math.max(clusterEnd, it.en);
    }
    if (cluster.length) flush();
  }

  function renderCalWeek(wrap) {
    const H = 44, now = new Date(), tk = todayKey();
    const start = startOfWeek(calAnchor);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const head = `<div class="cw-row cw-head"><div class="cw-gutter"></div>${days.map(d => `
      <button class="cw-dayhead ${keyOf(d) === tk ? 'today' : ''}" data-day="${keyOf(d)}"><span>${d.toLocaleDateString([], { weekday: 'short' })}</span><b>${d.getDate()}</b></button>`).join('')}</div>`;
    const allday = `<div class="cw-row cw-allday"><div class="cw-gutter">All day</div>${days.map(d => {
      const k = keyOf(d);
      const chips = [...occasionsOn(k).map(chipOcc), ...eventsOn(k).filter(e => e.allDay).map(e => chipEv(e, false)), ...tasksDue(k).map(chipTask)];
      return `<div class="cw-adcell">${chips.join('')}</div>`;
    }).join('')}</div>`;
    const cols = days.map(d => {
      const k = keyOf(d), ds = fromKey(k).getTime(), de = addDays(fromKey(k), 1).getTime();
      const items = eventsOn(k).filter(e => !e.allDay).map(e => ({ e, s: Math.max(+e.start, ds), en: Math.min(+e.end, de) }));
      layoutDay(items);
      const blocks = items.map(x => {
        const top = (x.s - ds) / 3600000 * H;
        const h = Math.max(20, (x.en - x.s) / 3600000 * H - 2);
        return `<button class="cw-ev ${x.e.source === 'manual' ? 'manual' : ''} ${x.en < +now ? 'past' : ''} ${h < 34 ? 'short' : ''}" data-ev="${reg(x.e)}"
          style="top:${top}px;height:${h}px;left:calc(${x.col / x.ncols * 100}% + 2px);width:calc(${100 / x.ncols}% - 4px)">
          <b>${esc(x.e.title)}</b><span>${esc(shortTime(x.e.start))} - ${esc(shortTime(x.e.end))}</span></button>`;
      }).join('');
      const nowLine = k === tk ? `<div class="cw-now" style="top:${(+now - ds) / 3600000 * H}px"></div>` : '';
      return `<div class="cw-col ${k === tk ? 'today' : ''}">${blocks}${nowLine}</div>`;
    }).join('');
    const hours = Array.from({ length: 24 }, (_, h) => `<div class="cw-hour" style="top:${h * H}px">${h === 0 ? '' : new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })}</div>`).join('');
    wrap.innerHTML = `<div class="cal-week">${head}${allday}<div class="cw-body" id="cwBody"><div class="cw-grid" style="height:${24 * H}px"><div class="cw-gutter cw-hours">${hours}</div>${cols}</div></div></div>`;
    const end = addDays(start, 6);
    const sameMonth = start.getMonth() === end.getMonth();
    $('#calTitle').textContent = sameMonth
      ? `${start.toLocaleDateString([], { month: 'long' })} ${start.getDate()} - ${end.getDate()}, ${end.getFullYear()}`
      : `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${end.getFullYear()}`;
    return [start, addDays(start, 7)];
  }

  function renderCalMonth(wrap) {
    const tk = todayKey();
    const y = calAnchor.getFullYear(), m = calAnchor.getMonth();
    const first = new Date(y, m, 1);
    const gridStart = startOfWeek(first);
    const weeks = Math.ceil((first.getDay() + new Date(y, m + 1, 0).getDate()) / 7);
    const names = Array.from({ length: 7 }, (_, i) => addDays(gridStart, i).toLocaleDateString([], { weekday: 'short' }));
    let cells = '';
    for (let i = 0; i < weeks * 7; i++) {
      const d = addDays(gridStart, i), k = keyOf(d);
      const chips = [
        ...occasionsOn(k).map(chipOcc),
        ...eventsOn(k).map(e => chipEv(e, true)),
        ...tasksDue(k).map(chipTask)
      ];
      const shown = chips.slice(0, 3).join('');
      const more = chips.length > 3 ? `<button class="cm-more" data-day="${k}">+${chips.length - 3} more</button>` : '';
      cells += `<div class="cm-cell ${d.getMonth() !== m ? 'out' : ''} ${k === tk ? 'today' : ''}">
        <button class="cm-num" data-day="${k}">${d.getDate()}</button>${shown}${more}</div>`;
    }
    wrap.innerHTML = `<div class="cal-month"><div class="cm-names">${names.map(n => `<div>${n}</div>`).join('')}</div>
      <div class="cm-grid" style="grid-template-rows:repeat(${weeks}, minmax(112px, 1fr))">${cells}</div></div>`;
    $('#calTitle').textContent = first.toLocaleDateString([], { month: 'long', year: 'numeric' });
    return [gridStart, addDays(gridStart, weeks * 7)];
  }

  function renderCalendar() {
    const wrap = $('#calWrap'); if (!wrap) return;
    const prevScroll = $('#cwBody') ? $('#cwBody').scrollTop : null;
    evRegistry = new Map();
    $$('.seg button').forEach(b => b.classList.toggle('active', b.dataset.mode === calMode));
    const [from, to] = calMode === 'month' ? renderCalMonth(wrap) : renderCalWeek(wrap);
    const body = $('#cwBody');
    if (body) {
      if (calScrollReset || prevScroll == null) {
        const now = new Date();
        const inWeek = now >= from && now < to;
        body.scrollTop = Math.max(0, (inWeek ? Math.min(now.getHours() - 1, 15) : 7) * 44);
        calScrollReset = false;
      } else body.scrollTop = prevScroll;
    }
    const linked = hasApi ? state.settings.icsUrl : state.settings.bridgeUrl;
    const t0 = addDays(new Date(), -OUTLOOK_BACK), t1 = addDays(new Date(), OUTLOOK_AHEAD);
    $('#calNote').textContent = linked && (from < t0 || to > t1)
      ? `Outlook events are loaded from ${t0.toLocaleDateString([], { month: 'short', day: 'numeric' })} to ${t1.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}.`
      : '';
  }

  // ---------- popover for calendar items ----------
  function showPopover(html, anchor) {
    const p = $('#calPop');
    p.innerHTML = `<button class="x pop-close" aria-label="Close">&times;</button>${html}`;
    p.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = p.offsetWidth, h = p.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - w - 12);
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    p.style.left = Math.max(8, left) + 'px'; p.style.top = top + 'px';
  }
  const hidePopover = () => { const p = $('#calPop'); if (p) p.hidden = true; };

  function eventPopover(e, anchor) {
    const when = e.allDay
      ? `${e.start.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })} · All day`
      : `${e.start.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })} · ${fmtTime(e.start)} - ${fmtTime(e.end)}`;
    showPopover(`<h3>${esc(e.title)}</h3><p>${esc(when)}</p>
      ${e.location ? `<p class="pop-loc">${linkify(e.location)}</p>` : ''}
      <p class="pop-src">${e.source === 'manual' ? 'Added in DayBrief' : 'From Outlook'}</p>
      ${e.source === 'manual' ? `<button class="btn btn-ghost btn-sm" data-del-meeting="${esc(e.id)}">Delete meeting</button>` : ''}`, anchor);
  }

  function taskPopover(t, anchor) {
    showPopover(`<h3>${esc(t.title)}</h3><p>Due ${esc(fromKey(t.due).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }))}${t.priority === 'high' ? ' · high priority' : ''}</p>
      ${t.link ? `<p><a href="#" data-url="${esc(t.link)}">${esc(linkLabel(t.link))} &#8599;</a></p>` : ''}
      <button class="btn btn-sm" data-pop-done="${esc(t.id)}">Mark done</button>`, anchor);
  }

  // ---------- render: occasions ----------
  function renderOccasions() {
    const ul = $('#allOccasions'); ul.innerHTML = '';
    const all = sortedOccasions();
    if (!all.length) ul.innerHTML = catEmpty('sit', 'No dates yet. Add the first one on the left.');
    all.forEach(x => ul.appendChild(occItem(x, true)));
  }

  // ---------- render: settings ----------
  function renderSettings() {
    const s = state.settings;
    if (document.activeElement !== $('#setName')) $('#setName').value = s.name || '';
    if (document.activeElement !== $('#setIcs')) $('#setIcs').value = s.icsUrl || '';
    $('#setKoreaClock').checked = s.koreaClock !== false;
    $('#setLogin').checked = !!s.launchAtLogin;
    $('#setPopup').checked = !!s.popupDaily;
    $('#setHour').value = String(s.popupAfterHour ?? 5);
    $('#setRemind').value = String(s.meetingReminderMin ?? 10);
    $('#setLead').value = String(s.occasionLeadDays ?? 14);
    if (!hasApi) {
      $('#setLogin').disabled = true; $('#setPopup').disabled = true; $('#testPopupBtn').disabled = true;
    }
  }

  function renderSync() {
    const el = $('#syncStatus');
    const o = state.outlook || {};
    el.classList.remove('err');
    let txt = '';
    const linked = hasApi ? state.settings.icsUrl : state.settings.bridgeUrl;
    if (!linked) txt = 'Outlook not connected.';
    else if (o.error) { txt = `Outlook sync problem: ${o.error}`; el.classList.add('err'); }
    else if (o.fetchedAt) txt = `Outlook synced ${fmtTime(new Date(o.fetchedAt))}`;
    else txt = 'Syncing Outlook...';
    el.textContent = txt;
    $('#icsStatus').textContent = txt;
    $('#bridgeStatus').textContent = txt;
  }

  function render() {
    renderToday(); renderNews(); renderTasks(); renderCalendar(); renderOccasions(); renderSettings(); renderSync();
  }

  // ---------- navigation ----------
  function go(view) {
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    $$('.view').forEach(v => { v.hidden = v.id !== `view-${view}`; });
    $('.main').scrollTop = 0;
    hidePopover();
    if (view === 'calendar') { calScrollReset = true; renderCalendar(); }
  }

  function setPopup(on) {
    popupOn = on;
    $('#popupBar').hidden = !on;
    if (on) { go('today'); render(); $('#startDayBtn').focus(); }
  }

  // ---------- wire up ----------
  function bind() {
    $$('.nav-btn').forEach(b => b.addEventListener('click', () => go(b.dataset.view)));
    document.addEventListener('click', (e) => {
      const g = e.target.closest('[data-goto]');
      if (g) { e.preventDefault(); go(g.dataset.goto); }
      const a = e.target.closest('a[data-url]');
      if (a) {
        e.preventDefault();
        if (hasApi) window.api.openExternal(a.dataset.url); else window.open(a.dataset.url, '_blank', 'noopener');
      }
      const dm = e.target.closest('[data-del-meeting]');
      if (dm) { state.meetings = state.meetings.filter(m => m.id !== dm.dataset.delMeeting); save(); render(); }
      const dO = e.target.closest('[data-del-occ]');
      if (dO) {
        const o = state.occasions.find(x => x.id === dO.dataset.delOcc);
        if (o && confirm(`Delete ${o.name}?`)) { state.occasions = state.occasions.filter(x => x !== o); save(); render(); }
      }
    });

    // tasks (delegated)
    document.addEventListener('change', (e) => {
      if (e.target.matches('.task input[type=checkbox]')) {
        const t = state.todos.find(x => x.id === e.target.closest('.task').dataset.id);
        if (t) { t.done = e.target.checked; t.doneAt = t.done ? Date.now() : null; save(); setTimeout(render, 250); }
      }
    });
    document.addEventListener('click', (e) => {
      const del = e.target.closest('.task .x');
      if (del) {
        const id = del.closest('.task').dataset.id;
        const t = state.todos.find(x => x.id === id);
        state.todos = state.todos.filter(x => x.id !== id);
        save(); render();
        if (t) toast(`Deleted "${t.title.slice(0, 30)}"`);
        return;
      }
      const title = e.target.closest('.task .title');
      if (title) startEditTask(title.closest('.task'));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('.task .title')) startEditTask(e.target.closest('.task'));
    });

    // notes autosave
    let noteTimer = null;
    $('#notes').addEventListener('input', (e) => {
      state.notes = e.target.value; save();
      $('#noteSaved').textContent = 'Saving...';
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => { $('#noteSaved').textContent = 'Saved'; }, 600);
    });

    ['#quickTask', '#quickTask2', '#quickAny'].forEach(sel => {
      const f = $(sel);
      f.addEventListener('submit', (e) => { e.preventDefault(); addTask(f); });
      f.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); addTask(f); } });
    });

    // AI news language
    $$('.news-tools .seg button').forEach(b => b.addEventListener('click', () => {
      state.settings.newsLang = b.dataset.lang; save(); renderNews();
    }));

    // calendar controls
    $('#calToday').addEventListener('click', () => { calAnchor = new Date(); calScrollReset = true; renderCalendar(); });
    $('#calPrev').addEventListener('click', () => {
      calAnchor = calMode === 'month' ? new Date(calAnchor.getFullYear(), calAnchor.getMonth() - 1, 1) : addDays(calAnchor, -7);
      calScrollReset = true; hidePopover(); renderCalendar();
    });
    $('#calNext').addEventListener('click', () => {
      calAnchor = calMode === 'month' ? new Date(calAnchor.getFullYear(), calAnchor.getMonth() + 1, 1) : addDays(calAnchor, 7);
      calScrollReset = true; hidePopover(); renderCalendar();
    });
    $$('.seg button').forEach(b => b.addEventListener('click', () => {
      calMode = b.dataset.mode; state.settings.calMode = calMode; save();
      calScrollReset = true; hidePopover(); renderCalendar();
    }));
    $('#calWrap').addEventListener('click', (e) => {
      const ev = e.target.closest('[data-ev]');
      if (ev) { const item = evRegistry.get(ev.dataset.ev); if (item) eventPopover(item, ev); e.stopPropagation(); return; }
      const tsk = e.target.closest('[data-task]');
      if (tsk) { const t = state.todos.find(x => x.id === tsk.dataset.task); if (t) taskPopover(t, tsk); e.stopPropagation(); return; }
      const day = e.target.closest('[data-day]');
      if (day && calMode === 'month') { calAnchor = fromKey(day.dataset.day); calMode = 'week'; state.settings.calMode = 'week'; save(); calScrollReset = true; renderCalendar(); }
    });
    document.addEventListener('click', (e) => {
      const p = $('#calPop');
      if (p.hidden) return;
      const done = e.target.closest('[data-pop-done]');
      if (done) {
        const t = state.todos.find(x => x.id === done.dataset.popDone);
        if (t) { t.done = true; t.doneAt = Date.now(); save(); render(); toast(`Done: ${t.title.slice(0, 30)}`); }
        hidePopover(); return;
      }
      if (e.target.closest('.pop-close') || e.target.closest('[data-del-meeting]') || !p.contains(e.target)) setTimeout(hidePopover, 0);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePopover(); });

    $$('.filter').forEach(b => b.addEventListener('click', () => {
      taskFilter = b.dataset.filter;
      $$('.filter').forEach(x => x.classList.toggle('active', x === b));
      renderTasks();
    }));

    // meetings
    const mf = $('#meetingForm');
    $('#addMeetingBtn').addEventListener('click', () => {
      mf.hidden = !mf.hidden;
      if (!mf.hidden) { mf.elements.date.value = todayKey(); mf.elements.title.focus(); }
    });
    mf.querySelector('[data-cancel]').addEventListener('click', () => { mf.reset(); mf.hidden = true; });
    mf.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(mf);
      state.meetings.push({ id: uid(), title: f.get('title').trim(), date: f.get('date'), time: f.get('time'), endTime: f.get('endTime'), location: f.get('location').trim() });
      mf.reset(); mf.hidden = true; save(); render();
    });

    // occasions
    const monthOptions = (lunar) => MONTHS.map((m, i) => `<option value="${i + 1}">${lunar ? `Month ${i + 1}` : m}</option>`).join('');
    $('#occMonth').innerHTML = monthOptions(false);
    const of = $('#occForm');
    const syncLunarUi = () => {
      const lunar = of.elements.lunar.checked;
      const keep = $('#occMonth').value;
      $('#occMonth').innerHTML = monthOptions(lunar); $('#occMonth').value = keep;
      $('#occLeapWrap').hidden = !lunar;
      if (!lunar) of.elements.leap.checked = false;
      $('#occHint').textContent = lunar
        ? 'Enter the lunar month and day. DayBrief works out the solar date every year.'
        : '';
    };
    of.elements.lunar.addEventListener('change', () => {
      if (of.elements.lunar.checked) of.elements.kst.checked = true; // lunar dates are usually kept by the Korean date
      syncLunarUi();
    });
    of.addEventListener('reset', () => setTimeout(syncLunarUi, 0));
    of.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(of);
      const lunar = !!f.get('lunar');
      const month = Number(f.get('month')), day = Number(f.get('day'));
      const max = lunar ? 30 : new Date(2024, month, 0).getDate();
      if (day < 1 || day > max) { toast(lunar ? 'A lunar month has at most 30 days.' : `${MONTHS[month - 1]} has ${max} days.`); return; }
      if (lunar && !getLunarFmt()) { toast('This browser cannot convert lunar dates.'); return; }
      state.occasions.push({
        id: uid(), name: f.get('name').trim(), type: f.get('type'), month, day,
        year: f.get('year') ? Number(f.get('year')) : null, note: f.get('note').trim(),
        lunar, leap: lunar && !!f.get('leap'), kst: !!f.get('kst')
      });
      of.reset(); save(); render(); toast('Saved.');
      of.elements.name.focus();
    });

    // settings
    $('#setHour').innerHTML = Array.from({ length: 12 }, (_, h) => `<option value="${h}">${h === 0 ? 'Any time' : `${h}:00 AM`}</option>`).join('');
    $('#setName').addEventListener('input', (e) => { state.settings.name = e.target.value.trim(); save(); renderToday(); });
    $('#setKoreaClock').addEventListener('change', (e) => { state.settings.koreaClock = e.target.checked; save(); renderToday(); });
    $('#saveIcsBtn').addEventListener('click', async () => {
      state.settings.icsUrl = $('#setIcs').value.trim();
      if (!hasApi) { save(); toast('Calendar sync works in the desktop app.'); return; }
      $('#icsStatus').textContent = 'Syncing...';
      await window.api.save(state);
      const o = await window.api.refreshOutlook();
      state.outlook = o; render();
      toast(o.error ? 'Could not read that link.' : `Synced ${o.events.length} events.`);
    });
    $('#setLogin').addEventListener('change', (e) => { state.settings.launchAtLogin = e.target.checked; save(); });
    $('#setPopup').addEventListener('change', (e) => { state.settings.popupDaily = e.target.checked; save(); });
    $('#setHour').addEventListener('change', (e) => { state.settings.popupAfterHour = Number(e.target.value); save(); });
    $('#setRemind').addEventListener('change', (e) => { state.settings.meetingReminderMin = Number(e.target.value); save(); });
    $('#setLead').addEventListener('change', (e) => { state.settings.occasionLeadDays = Number(e.target.value); save(); render(); });
    $('#testPopupBtn').addEventListener('click', () => {
      if (hasApi) { toast('Hide this window. The popup appears in 3 seconds.'); setTimeout(() => window.api.testPopup(), 3000); }
    });

    $('#exportBtn').addEventListener('click', () => {
      const { outlook, ...rest } = state;
      const backup = { ...rest, settings: { ...rest.settings, icsUrl: rest.settings.icsUrl } };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `daybrief-backup-${todayKey()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('#importFile').addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const d = JSON.parse(await file.text());
        if (!Array.isArray(d.todos) || !Array.isArray(d.occasions)) throw new Error('bad');
        if (!confirm('Replace your current tasks, meetings and dates with this backup?')) return;
        state.todos = d.todos; state.meetings = d.meetings || []; state.occasions = d.occasions;
        if (typeof d.notes === 'string') state.notes = d.notes;
        state.settings = { ...state.settings, ...(d.settings || {}), lastPopupDate: state.settings.lastPopupDate };
        save(); render(); toast('Backup restored.');
      } catch (err) { toast('That file is not a DayBrief backup.'); }
      e.target.value = '';
    });

    $('#startDayBtn').addEventListener('click', () => {
      setPopup(false);
      if (hasApi) window.api.dismissPopup();
    });

    if (hasApi) {
      window.api.onPopupMode(setPopup);
      window.api.onOutlookUpdated((o) => { state.outlook = o; render(); });
      window.api.info().then(i => {
        $('#appInfo').textContent = `DayBrief ${i.version}`;
        if (i.platform === 'darwin') document.body.classList.add('is-mac');
      });
    } else {
      $('#appInfo').textContent = 'Your data is saved in this browser on this computer. Use Export backup to move it.';
    }

    // keep "now" markers and the date fresh
    let lastDay = todayKey();
    setInterval(() => {
      if (todayKey() !== lastDay) { lastDay = todayKey(); }
      if (!document.querySelector('.title-edit')) render();
    }, 60 * 1000);
  }

  // ---------- demo data for browser preview ----------
  function demoData() {
    const now = new Date();
    const k = (n) => keyOf(addDays(now, n));
    const at = (n, h, m) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + n, h, m).toISOString();
    const md = (n) => { const d = addDays(now, n); return { month: d.getMonth() + 1, day: d.getDate() }; };
    return {
      todos: [
        { id: uid(), title: 'Grade EDTE 250 reflections', due: k(0), priority: 'high', done: false, createdAt: 1 },
        { id: uid(), title: 'Send AI Literacy Committee agenda', due: k(-1), priority: 'normal', done: false, createdAt: 2 },
        { id: uid(), title: 'Book room for externship talk', due: k(2), priority: 'normal', done: false, createdAt: 3 },
        { id: uid(), title: 'Review IOHSK proposals', due: '', priority: 'low', done: false, createdAt: 4 },
        { id: uid(), title: 'Reply to Reiko about data analysis', due: k(0), priority: 'normal', done: true, doneAt: Date.now(), createdAt: 5 }
      ],
      meetings: [{ id: uid(), title: 'Coffee with Sally', date: k(0), time: '15:30', endTime: '16:00', location: 'Starbucks, Student Center' }],
      occasions: [
        { id: uid(), name: 'Mom', type: 'birthday', ...md(3), year: 1958, note: 'Call in the morning (Korea time)' },
        { id: uid(), name: 'Wedding anniversary', type: 'anniversary', ...md(11), year: 2012, note: '' },
        { id: uid(), name: 'Pam', type: 'birthday', ...md(25), year: null, note: '' }
      ],
      outlook: {
        fetchedAt: new Date().toISOString(), error: null,
        events: [
          { id: 'o1', title: 'Department meeting', location: 'TC 1010', start: at(0, 9, 0), end: at(0, 10, 0), allDay: false, source: 'outlook' },
          { id: 'o2', title: 'EDEL 350 co-teaching', location: 'TC 215', start: at(0, 11, 0), end: at(0, 12, 15), allDay: false, source: 'outlook' },
          { id: 'o3', title: 'Research check-in: Reiko & Sally', location: 'https://bsu.zoom.us/j/123456789', start: at(0, 13, 30), end: at(0, 14, 15), allDay: false, source: 'outlook' },
          { id: 'o4', title: 'Office hours', location: 'TC 1203', start: at(1, 10, 0), end: at(1, 12, 0), allDay: false, source: 'outlook' },
          { id: 'o5', title: 'ECE AI PD planning', location: '', start: at(2, 14, 0), end: at(2, 15, 0), allDay: false, source: 'outlook' }
        ]
      },
      settings: { name: 'Henry', icsUrl: 'demo', launchAtLogin: true, popupDaily: true, popupAfterHour: 5, meetingReminderMin: 10, occasionLeadDays: 14 }
    };
  }

  // ---------- browser-only version ----------
  let bridgeBusy = false;

  // Load the bridge through a <script> tag (JSONP). Works from a file opened on disk,
  // where browsers block normal cross-site requests.
  function loadViaScript(url) {
    return new Promise((resolve, reject) => {
      const cb = 'dbBridge_' + Date.now().toString(36);
      const s = document.createElement('script');
      let settled = false;
      const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); delete window[cb]; s.remove(); fn(v); };
      const timer = setTimeout(() => done(reject, new Error('timeout')), 25000);
      window[cb] = (text) => done(resolve, String(text || ''));
      s.onerror = () => done(reject, new Error('script-error'));
      s.onload = () => setTimeout(() => done(reject, new Error('no-callback')), 50);
      s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb + '&t=' + Date.now();
      document.head.appendChild(s);
    });
  }

  async function loadViaFetch(url) {
    const res = await fetch(url, { redirect: 'follow', cache: 'no-store' });
    if (!res.ok) throw new Error(`The bridge answered with error ${res.status}.`);
    return res.text();
  }

  async function syncBridge(showToast) {
    const url = (state.settings.bridgeUrl || '').trim();
    if (!url || bridgeBusy) return;
    bridgeBusy = true;
    try {
      let text = null;
      try { text = await loadViaScript(url); } catch (e) { /* older bridge code: try a normal request */ }
      if (text == null) {
        try { text = await loadViaFetch(url); }
        catch (e) {
          throw new Error('Could not read the bridge. Update the code in Apps Script to the newest version below, then Deploy > Manage deployments > edit > New version > Deploy.');
        }
      }
      if (!text.includes('BEGIN:VCALENDAR')) {
        throw new Error(/<html/i.test(text)
          ? 'The bridge asked for a sign-in. In Apps Script, set "Who has access" to Anyone and deploy a new version.'
          : 'The bridge did not return a calendar. Check the ICS link inside the script.');
      }
      const now = new Date();
      const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - OUTLOOK_BACK);
      const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + OUTLOOK_AHEAD, 23, 59, 59);
      const events = window.DayBriefICS.expandIcs(text, from, to);
      state.outlook = { events, fetchedAt: new Date().toISOString(), error: null };
      if (showToast) toast(`Synced ${events.length} events.`);
    } catch (e) {
      state.outlook = { ...(state.outlook || {}), error: e.message || String(e) };
      if (showToast) toast('Could not sync. See Settings.');
    } finally {
      bridgeBusy = false;
      save(); render();
    }
  }

  const syncBase = () => (state.settings.bridgeUrl || '').trim();
  let syncBusy = false;

  function setSyncStatus(msg, isErr) {
    state.syncStatus = { msg, err: !!isErr, at: Date.now() };
    const el = $('#syncState'); if (el) { el.textContent = msg; el.classList.toggle('err', !!isErr); }
  }

  function pushRemote(beacon) {
    const url = syncBase();
    if (!url || !state.settings.syncOn) return;
    clearTimeout(pushTimer); pushTimer = null;
    const body = JSON.stringify({ action: 'save', payload: { savedAt: state.updatedAt || Date.now(), data: syncedData() } });
    if (beacon && navigator.sendBeacon) { navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' })); return; }
    fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body })
      .then(() => { state.settings.lastPushAt = Date.now(); setSyncStatus(`Saved to Google Drive ${fmtTime(new Date())}`); save(); })
      .catch(() => setSyncStatus('Could not save to Google Drive. Will try again.', true));
  }

  function applyRemote(remote) {
    const d = remote.data || {};
    state.todos = Array.isArray(d.todos) ? d.todos : [];
    state.meetings = Array.isArray(d.meetings) ? d.meetings : [];
    state.occasions = Array.isArray(d.occasions) ? d.occasions : [];
    state.notes = typeof d.notes === 'string' ? d.notes : '';
    if (d.profile) {
      if (typeof d.profile.name === 'string') state.settings.name = d.profile.name;
      if (d.profile.occasionLeadDays) state.settings.occasionLeadDays = d.profile.occasionLeadDays;
      if (d.profile.meetingReminderMin != null) state.settings.meetingReminderMin = d.profile.meetingReminderMin;
    }
    state.updatedAt = remote.savedAt;
    lastFp = fingerprint();
    save(); render();
  }

  const hasLocalData = () => state.todos.length || state.meetings.length || state.occasions.length || (state.notes || '').trim();

  async function pullRemote(firstTime) {
    const url = syncBase();
    if (!url || !state.settings.syncOn || syncBusy) return;
    syncBusy = true;
    try {
      const text = await loadViaScript(url + (url.includes('?') ? '&' : '?') + 'action=load');
      if (text.includes('BEGIN:VCALENDAR')) throw new Error('old-code');
      let remote = null;
      if (text.trim()) { try { remote = JSON.parse(text); } catch (e) { throw new Error('bad-data'); } }
      const remoteHas = remote && remote.data && ((remote.data.todos || []).length || (remote.data.occasions || []).length || (remote.data.meetings || []).length || (remote.data.notes || '').trim());

      if (firstTime) {
        if (remoteHas && hasLocalData()) {
          const useDrive = confirm('Your Google Drive already has DayBrief data (from another computer).\n\nOK: use the Google Drive data on this computer.\nCancel: keep this computer\'s data and save it to Google Drive.');
          if (useDrive) applyRemote(remote); else { state.updatedAt = Date.now(); pushRemote(); }
        } else if (remoteHas) applyRemote(remote);
        else { state.updatedAt = state.updatedAt || Date.now(); pushRemote(); }
        state.settings.syncLinked = true; save();
      } else if (remote && (remote.savedAt || 0) > (state.updatedAt || 0)) {
        if (document.activeElement === $('#notes') || document.querySelector('.title-edit')) return; // don't disturb typing
        applyRemote(remote);
      } else if (!remote || (state.updatedAt || 0) > (remote.savedAt || 0)) {
        pushRemote();
      }
      setSyncStatus(`Synced with Google Drive ${fmtTime(new Date())}`);
    } catch (e) {
      setSyncStatus(e.message === 'old-code'
        ? 'Update the bridge code to the newest version to use sync (see steps below).'
        : 'Could not reach Google Drive. Check the bridge, then try again.', true);
    } finally {
      syncBusy = false;
    }
  }

  function browserMode() {
    $('#browserSync').hidden = false;
    $('#setSync').checked = !!state.settings.syncOn;
    if (state.syncStatus) setSyncStatus(state.syncStatus.msg, state.syncStatus.err);
    else if (!state.settings.syncOn) setSyncStatus('Off. Your data is only on this computer.');
    $('#setSync').addEventListener('change', (e) => {
      if (e.target.checked && !syncBase()) {
        const typed = $('#setBridge').value.trim();
        if (typed) { state.settings.bridgeUrl = typed; save(); syncBridge(false); }
        else {
          e.target.checked = false;
          toast('Paste your bridge address (the /exec link) in Outlook calendar above first.');
          $('#setBridge').focus(); return;
        }
      }
      state.settings.syncOn = e.target.checked;
      if (!e.target.checked) { state.settings.syncLinked = false; setSyncStatus('Off. Your data is only on this computer.'); save(); return; }
      setSyncStatus('Connecting to Google Drive...'); save();
      pullRemote(true);
    });
    $('#syncNowBtn').addEventListener('click', () => {
      if (!state.settings.syncOn) { toast('Tick "Sync my DayBrief data" first.'); return; }
      setSyncStatus('Syncing...'); pullRemote(!state.settings.syncLinked);
    });
    if (state.settings.syncOn) pullRemote(!state.settings.syncLinked);
    setInterval(() => pullRemote(false), 3 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') pullRemote(false);
      else if (pushTimer) pushRemote(true);
    });
    window.addEventListener('pagehide', () => { if (pushTimer) pushRemote(true); });

    $('#setBridge').value = state.settings.bridgeUrl || '';
    $('#saveBridgeBtn').addEventListener('click', () => {
      state.settings.bridgeUrl = $('#setBridge').value.trim();
      if (!state.settings.bridgeUrl) { state.outlook = { events: [] }; save(); render(); return; }
      $('#bridgeStatus').textContent = 'Syncing...';
      syncBridge(true);
    });
    $('#copyCodeBtn').addEventListener('click', async () => {
      const code = $('#bridgeCode').textContent;
      try { await navigator.clipboard.writeText(code); }
      catch (e) {
        const ta = document.createElement('textarea'); ta.value = code; document.body.appendChild(ta);
        ta.select(); document.execCommand('copy'); ta.remove();
      }
      toast('Code copied.');
    });
    if (state.settings.bridgeUrl) syncBridge(false);
    setInterval(() => syncBridge(false), 30 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      const last = state.outlook?.fetchedAt ? new Date(state.outlook.fetchedAt).getTime() : 0;
      if (document.visibilityState === 'visible' && Date.now() - last > 15 * 60 * 1000) syncBridge(false);
    });

    $('#browserOutlook').hidden = false; $('#appOutlook').hidden = true;
    $('#browserPopup').hidden = false; $('#appPopup').hidden = true;
    // Greeting bar the first time the page is opened each day.
    if (location.hash === '#popup' || state.settings.lastPopupDate !== todayKey()) {
      state.settings.lastPopupDate = todayKey(); save();
      setPopup(true);
    }
    // Meeting notifications while the page is open.
    $('#notifyBtn').addEventListener('click', async () => {
      if (!('Notification' in window)) { toast('This browser does not support notifications.'); return; }
      const r = await Notification.requestPermission();
      toast(r === 'granted' ? 'Notifications on.' : 'Notifications are blocked in this browser.');
    });
    const sent = new Set();
    setInterval(() => {
      const lead = Number(state.settings.meetingReminderMin) || 0;
      if (!lead || !('Notification' in window) || Notification.permission !== 'granted') return;
      const now = Date.now();
      eventsOn(todayKey()).filter(e => !e.allDay).forEach(e => {
        const t = e.start.getTime(), key = e.id + t;
        if (t - now <= lead * 60000 && t - now > -60000 && !sent.has(key)) {
          sent.add(key);
          new Notification(e.title, { body: fmtTime(e.start) + (e.location ? ' · ' + e.location : '') });
        }
      });
    }, 30000);
  }

  // ---------- start ----------
  (async () => {
    state = await load();
    state.todos ||= []; state.meetings ||= []; state.occasions ||= [];
    state.settings ||= {}; state.outlook ||= { events: [] };
    // Tasks written before links were supported: turn a pasted URL into a link button.
    let migrated = false;
    for (const t of state.todos) {
      if (!t.link && URL_RE.test(t.title || '')) {
        const sp = splitTitleLink(t.title); t.title = sp.title; t.link = sp.link; migrated = true;
      }
    }
    lastFp = fingerprint();
    if (migrated) save();
    if (state.settings.calMode === 'month') calMode = 'month';
    bind();
    render();
    if (!hasApi) browserMode();
    loadNews();
    setInterval(loadNews, 3 * 60 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      const u = state.news && state.news.updated ? new Date(state.news.updated).getTime() : 0;
      if (document.visibilityState === 'visible' && Date.now() - u > 20 * 60 * 60 * 1000) loadNews();
    });
  })();
})();
