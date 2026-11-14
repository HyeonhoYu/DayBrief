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
  function save() {
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
  function nextOccurrence(o) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const make = (y) => {
      const m = o.month - 1;
      const last = new Date(y, m + 1, 0).getDate();
      return new Date(y, m, Math.min(o.day, last));
    };
    let d = make(today.getFullYear());
    if (d < today) d = make(today.getFullYear() + 1);
    const days = Math.round((d - today) / 86400000);
    const years = o.year ? d.getFullYear() - Number(o.year) : null;
    return { date: d, days, years };
  }

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
      <span class="meta ${!t.done && b === 'overdue' ? 'overdue' : ''} ${!t.done && b === 'today' ? 'today' : ''}">${esc(dueText(t))}</span>
      <button class="x" title="Delete" aria-label="Delete task">&times;</button>`;
    return li;
  }

  function addTask(form) {
    const f = new FormData(form);
    const title = String(f.get('title') || '').trim();
    if (!title) return;
    state.todos.push({ id: uid(), title, due: f.get('due') || '', priority: f.get('priority') || 'normal', done: false, createdAt: Date.now() });
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
      <select class="te-prio"><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select>`;
    wrap.querySelector('.te-prio').value = t.priority || 'normal';
    span.replaceWith(wrap); meta.hidden = true;
    const input = wrap.querySelector('.te-title');
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
    const commit = () => {
      const v = input.value.trim();
      if (v) t.title = v;
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
      next ? `<span class="chip">Next: <b>${esc(fmtTime(next.start))}</b> ${esc(next.title.slice(0, 28))}</span>` : ''
    ].join('');

    // banner for today's occasions
    const todayOcc = occ.filter(x => x.n.days === 0);
    const banner = $('#occasionBanner');
    if (todayOcc.length) {
      banner.hidden = false;
      banner.innerHTML = `${catImg('fly', 'banner-cat')}<div>Today: ${todayOcc.map(x => `<b>${esc(x.o.name)}</b> (${esc(occasionLabel(x.o, x.n))})`).join(', ')}.${todayOcc.some(x => x.o.note) ? ' ' + todayOcc.filter(x => x.o.note).map(x => esc(x.o.note)).join(' · ') : ''}</div>`;
    } else banner.hidden = true;

    // schedule
    const ol = $('#todaySchedule'); ol.innerHTML = '';
    if (!todays.length) ol.innerHTML = catEmpty('stretch', state.settings.icsUrl || !hasApi ? 'No meetings today. Time for a good stretch.' : 'No meetings yet. Connect Outlook in Settings or add one here.');
    todays.forEach(e => ol.appendChild(evItem(e, now)));

    const tom = eventsOn(keyOf(addDays(now, 1)));
    const ol2 = $('#tomorrowSchedule'); ol2.innerHTML = '';
    if (!tom.length) ol2.innerHTML = '<li class="empty">Nothing scheduled.</li>';
    tom.forEach(e => ol2.appendChild(evItem(e, now, true)));

    // tasks
    const focus = open.filter(t => ['overdue', 'today', 'nodate'].includes(taskBucket(t)))
      .sort((a, b) => ['overdue', 'today', 'nodate'].indexOf(taskBucket(a)) - ['overdue', 'today', 'nodate'].indexOf(taskBucket(b)) || sortTasks(a, b));
    const doneToday = state.todos.filter(t => t.done && t.doneAt && keyOf(new Date(t.doneAt)) === tk);
    const ul = $('#todayTasks'); ul.innerHTML = '';
    if (!focus.length && !doneToday.length) ul.innerHTML = catEmpty('eat', 'Nothing due today. Snack break earned.', true);
    focus.forEach(t => ul.appendChild(taskItem(t)));
    doneToday.forEach(t => ul.appendChild(taskItem(t)));
    const later = open.filter(t => ['tomorrow', 'week'].includes(taskBucket(t))).length;
    if (later) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.innerHTML = `${later} more due this week. <a href="#" data-goto="tasks">See all</a>`;
      ul.appendChild(li);
    }

    // occasions
    const ou = $('#todayOccasions'); ou.innerHTML = '';
    if (!soonOcc.length) ou.innerHTML = catEmpty('sit', occ.length ? `Nothing in the next ${lead} days.` : 'Add birthdays and anniversaries so you never miss one.', true);
    soonOcc.forEach(x => ou.appendChild(occItem(x, false)));

    // popup bar text
    $('#popupGreeting').textContent = `${greet}${name}.`;
    const bits = [];
    bits.push(`${timed.length} meeting${timed.length === 1 ? '' : 's'}`);
    bits.push(`${dueNow.length} task${dueNow.length === 1 ? '' : 's'} due`);
    if (todayOcc.length) bits.push(`${todayOcc.map(x => x.o.name).join(', ')} today`);
    else if (soonOcc[0]) bits.push(`${soonOcc[0].o.name} in ${soonOcc[0].n.days} day${soonOcc[0].n.days === 1 ? '' : 's'}`);
    $('#popupSummary').textContent = `Today: ${bits.join(' · ')}.`;
  }

  function occItem({ o, n }, full) {
    const li = document.createElement('li');
    li.className = `occ ${n.days === 0 ? 'today' : n.days <= 3 ? 'soon' : ''}`;
    const when = n.date.toLocaleDateString([], { weekday: full ? undefined : 'short', month: 'short', day: 'numeric' });
    li.innerHTML = `
      <span class="dday">${ddayText(n.days)}</span>
      <span class="who"><b>${esc(o.name)}</b><span>${esc(occasionLabel(o, n))} · ${esc(when)}${o.note ? ' · ' + esc(o.note) : ''}</span></span>
      <span class="kind ${esc(o.type)}">${o.type === 'birthday' ? 'Birthday' : o.type === 'anniversary' ? 'Anniv.' : 'Date'}</span>
      ${full ? `<button class="x" data-del-occ="${esc(o.id)}" title="Delete" aria-label="Delete date">&times;</button>` : ''}`;
    return li;
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

  // ---------- render: week ----------
  function renderWeek() {
    const grid = $('#weekGrid'); grid.innerHTML = '';
    const now = new Date();
    for (let i = 0; i < 7; i++) {
      const d = addDays(now, i); const k = keyOf(d);
      const col = document.createElement('div');
      col.className = 'day' + (i === 0 ? ' is-today' : '');
      let html = `<h3>${d.toLocaleDateString([], { weekday: 'short' })}<span>${d.getDate()}</span></h3>`;
      sortedOccasions().filter(x => keyOf(x.n.date) === k).forEach(x => {
        html += `<div class="item occ-item"><b>${esc(x.o.name)}</b><small>${esc(occasionLabel(x.o, x.n))}</small></div>`;
      });
      eventsOn(k).forEach(e => {
        html += `<div class="item ${e.source === 'manual' ? 'manual' : ''}"><small>${e.allDay ? 'All day' : esc(fmtTime(e.start))}</small>${esc(e.title)}</div>`;
      });
      state.todos.filter(t => !t.done && t.due === k).sort(sortTasks).forEach(t => {
        html += `<div class="item tsk"><small>Task${t.priority === 'high' ? ' · high' : ''}</small>${esc(t.title)}</div>`;
      });
      col.innerHTML = html;
      grid.appendChild(col);
    }
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
    if (!hasApi) { el.textContent = ''; return; }
    if (!state.settings.icsUrl) txt = 'Outlook not connected.';
    else if (o.error) { txt = `Outlook sync problem: ${o.error}`; el.classList.add('err'); }
    else if (o.fetchedAt) txt = `Outlook synced ${fmtTime(new Date(o.fetchedAt))}`;
    else txt = 'Syncing Outlook...';
    el.textContent = txt;
    $('#icsStatus').textContent = txt;
  }

  function render() {
    renderToday(); renderTasks(); renderWeek(); renderOccasions(); renderSettings(); renderSync();
  }

  // ---------- navigation ----------
  function go(view) {
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    $$('.view').forEach(v => { v.hidden = v.id !== `view-${view}`; });
    $('.main').scrollTop = 0;
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
        if (hasApi) window.api.openExternal(a.dataset.url); else window.open(a.dataset.url, '_blank');
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

    ['#quickTask', '#quickTask2'].forEach(sel => {
      const f = $(sel);
      f.addEventListener('submit', (e) => { e.preventDefault(); addTask(f); });
      f.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); addTask(f); } });
    });

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
    $('#occMonth').innerHTML = MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('');
    const of = $('#occForm');
    of.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(of);
      const month = Number(f.get('month')), day = Number(f.get('day'));
      const max = new Date(2024, month, 0).getDate();
      if (day < 1 || day > max) { toast(`${MONTHS[month - 1]} has ${max} days.`); return; }
      state.occasions.push({ id: uid(), name: f.get('name').trim(), type: f.get('type'), month, day, year: f.get('year') ? Number(f.get('year')) : null, note: f.get('note').trim() });
      of.reset(); save(); render(); toast('Saved.');
      of.elements.name.focus();
    });

    // settings
    $('#setHour').innerHTML = Array.from({ length: 12 }, (_, h) => `<option value="${h}">${h === 0 ? 'Any time' : `${h}:00 AM`}</option>`).join('');
    $('#setName').addEventListener('input', (e) => { state.settings.name = e.target.value.trim(); save(); renderToday(); });
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
  function browserMode() {
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
    bind();
    render();
    if (!hasApi) browserMode();
  })();
})();
