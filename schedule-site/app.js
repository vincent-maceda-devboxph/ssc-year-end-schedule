// Static match schedule (Bootstrap 5): reads schedule.json, no server and no live updates.
const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const FILTERS = [
  { key: 'division', label: 'Division', icon: 'diagram-3', of: (m) => m.division },
  { key: 'level', label: 'Level', icon: 'bar-chart-steps', of: (m) => m.level },
  { key: 'team', label: 'Team', icon: 'people', of: (m) => [m.a.team, m.b.team].filter(Boolean) },
  { key: 'court', label: 'Court', icon: 'grid-3x3-gap', of: (m) => m.court },
  { key: 'when', label: 'Time of day', icon: 'sun', of: (m) => (m.hour < 12 ? 'Morning' : m.hour < 17 ? 'Afternoon' : 'Evening') },
  { key: 'day', label: 'Day', icon: 'calendar-event', of: (m) => m.day },
];

let data;
let teamBy = new Map();
let sheet;
const state = { q: '', view: 'time', sel: Object.fromEntries(FILTERS.map((f) => [f.key, new Set()])) };

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tokens = (q) => norm(q).split(/[\s,]+/).filter(Boolean);
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const num = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
const teamName = (id) => teamBy.get(id)?.name ?? '';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 'es'}`;

function hay(m) {
  if (m._hay) return m._hay;
  m._hay = norm([m.a.name, m.b.name, teamName(m.a.team), teamName(m.b.team), m.division, m.level, m.court, m.time, m.day, m.game ? `game ${m.game}` : ''].join(' | '));
  return m._hay;
}
function matches(m) {
  const tk = tokens(state.q);
  if (tk.length && !tk.every((t) => hay(m).includes(t))) return false;
  return FILTERS.every((f) => {
    const sel = state.sel[f.key];
    if (!sel.size) return true;
    const v = f.of(m);
    return Array.isArray(v) ? v.some((x) => sel.has(x)) : sel.has(v);
  });
}
/** Is this side the person being searched for? (highlighted green) */
function hitSide(side) {
  const tk = tokens(state.q);
  return tk.length > 0 && tk.some((t) => norm(side.name).includes(t));
}
function mark(text) {
  let out = esc(text);
  for (const t of tokens(state.q).filter((x) => x.length > 1)) {
    out = out.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>');
  }
  return out;
}
const isPast = (m) => Date.parse(m.start) + (data.tournament.matchMinutes ?? 30) * 60000 < Date.now();

// ---------- url ----------
function readUrl() {
  const p = new URLSearchParams(location.search);
  state.q = p.get('q') ?? '';
  state.view = p.get('view') === 'court' ? 'court' : 'time';
  for (const f of FILTERS) state.sel[f.key] = new Set((p.get(f.key) ?? '').split('|').filter(Boolean));
}
function writeUrl() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.view === 'court') p.set('view', 'court');
  for (const f of FILTERS) if (state.sel[f.key].size) p.set(f.key, [...state.sel[f.key]].join('|'));
  const s = p.toString();
  history.replaceState(null, '', s ? `?${s}` : location.pathname);
}

// ---------- pieces ----------
function logo(id, name, small = false) {
  const t = teamBy.get(id);
  const cls = `logo${small ? ' sm' : ''}`;
  if (t?.logo) return `<span class="${cls}"><img src="${esc(t.logo)}" alt="" loading="lazy"></span>`;
  return `<span class="${cls}" style="background:${esc(t?.color ?? '#e2e8f0')}" aria-hidden="true">${esc(initials(t?.name ?? name))}</span>`;
}
function pair(m, side) {
  const s = m[side];
  return `<div class="pair d-flex align-items-center gap-3${hitSide(s) ? ' hit' : ''}">${logo(s.team, s.name)}
    <div class="min-w-0"><div class="names">${mark(s.name)}</div><div class="small text-body-secondary">${esc(teamName(s.team))}</div></div></div>`;
}

function card(m, next) {
  const isNext = m === next;
  return `<div class="col-12 col-md-6 col-xl-4"><article class="card match h-100${isPast(m) ? ' past' : ''}${isNext ? ' next' : ''}">
    <div class="card-body pb-2">
      <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
        ${m.game ? `<span class="badge rounded-pill text-bg-primary px-3 py-2">Game ${m.game}</span>` : ''}
        <span class="badge rounded-pill tag-court px-3 py-2"><i class="bi bi-geo-alt-fill me-1"></i>${esc(m.court)}</span>
        <span class="badge rounded-pill bg-primary-subtle text-primary-emphasis px-3 py-2">${esc(m.level)}</span>
        ${isNext ? '<span class="badge rounded-pill text-bg-warning ms-auto px-3 py-2"><i class="bi bi-lightning-charge-fill me-1"></i>Next up</span>' : ''}
      </div>
      ${pair(m, 'a')}<div class="vs">VS</div>${pair(m, 'b')}
    </div>
    <div class="card-footer bg-transparent border-0 d-flex justify-content-between align-items-center pt-1 pb-3 px-3 small text-body-secondary">
      <span>${esc(m.division)}${m.round ? ' · ' + esc(m.round) : ''}</span>
      <button class="btn btn-sm btn-link text-decoration-none fw-semibold p-0" type="button" data-ics="${data.matches.indexOf(m)}"><i class="bi bi-calendar-plus me-1"></i>Add to calendar</button>
    </div></article></div>`;
}

function timeline(list, next) {
  let html = '';
  let day = '';
  const slots = new Map();
  for (const m of list) (slots.get(m.start) ?? slots.set(m.start, []).get(m.start)).push(m);
  for (const ms of slots.values()) {
    const first = ms[0];
    if (first.day !== day) { day = first.day; html += `<h2 class="day-title"><i class="bi bi-calendar3 me-2"></i>${esc(day)}</h2>`; }
    html += `<section class="slot"><div class="slot-time"><h3 class="h4">${esc(first.time)}</h3>
      <span class="text-body-secondary small">${first.until ? 'to ' + esc(first.until) : ''}</span>
      <span class="badge rounded-pill bg-body-secondary text-body-secondary">${plural(ms.length, 'match')}</span></div>
      <div class="row g-3">${ms.map((m) => card(m, next)).join('')}</div></section>`;
  }
  return html;
}

function courtsView(list, next) {
  const courts = [...new Set(list.map((m) => m.court))].sort(num);
  return `<div class="row g-3 row-cols-1 row-cols-md-2 row-cols-xl-4">${courts.map((c) => {
    const ms = list.filter((m) => m.court === c);
    return `<div class="col"><section class="court-card"><div class="court-head"><span><i class="bi bi-geo-alt-fill me-2"></i>${esc(c)}</span><span class="small fw-semibold opacity-75">${plural(ms.length, 'match')}</span></div>
      ${ms.map((m) => `<div class="court-row${isPast(m) ? ' past' : ''}"><div class="t">${esc(m.time)}<small>${esc(m.day.split(',')[0])}${m.game ? ' · G' + m.game : ''}</small></div>
        <div class="p small"><b class="${hitSide(m.a) ? 'hit' : ''}">${mark(m.a.name)}</b><div class="text-body-secondary" style="font-size:.7rem">vs</div><b class="${hitSide(m.b) ? 'hit' : ''}">${mark(m.b.name)}</b>
        <div class="mt-1"><span class="badge rounded-pill bg-primary-subtle text-primary-emphasis">${esc(m.level)}</span>${m === next ? ' <span class="badge rounded-pill text-bg-warning">Next up</span>' : ''}</div></div></div>`).join('')}</section></div>`;
  }).join('')}</div>`;
}

// ---------- render ----------
function render() {
  const list = data.matches.filter(matches);
  const filtering = state.q || FILTERS.some((f) => state.sel[f.key].size);
  const next = list.find((m) => !isPast(m));

  $('clear').classList.toggle('on', !!state.q);
  const active = FILTERS.reduce((n, f) => n + state.sel[f.key].size, 0);
  $('fcount').hidden = !active;
  $('fcount').textContent = active;
  $('v-time').classList.toggle('active', state.view === 'time');
  $('v-court').classList.toggle('active', state.view === 'court');

  $('chips').innerHTML = FILTERS.flatMap((f) => [...state.sel[f.key]].map((v) => {
    const label = f.key === 'team' ? teamName(v) : v;
    return `<span class="badge rounded-pill bg-primary-subtle text-primary-emphasis d-inline-flex align-items-center gap-2 ps-3 pe-2 py-2 fs-6 fw-semibold">${esc(label)}<button type="button" class="btn-close" style="width:.5rem;height:.5rem" data-rm="${f.key}" data-val="${esc(v)}" aria-label="Remove ${esc(label)}"></button></span>`;
  })).join('');

  const mine = store.get('sched.me');
  let sum = `<span class="fs-6"><b class="text-body">${list.length}</b> match${list.length === 1 ? '' : 'es'}${filtering ? ' found' : ''}</span>`;
  if (filtering) sum += `<button class="btn btn-link btn-sm fw-semibold p-0 text-decoration-none" type="button" id="reset-all"><i class="bi bi-x-circle me-1"></i>Clear everything</button>`;
  if (state.q && list.length && norm(state.q) !== norm(mine ?? '')) sum += `<button class="btn btn-sm btn-outline-primary rounded-pill fw-semibold" type="button" id="pin"><i class="bi bi-star me-1"></i>This is me, remember it</button>`;
  if (mine && norm(state.q) !== norm(mine)) sum += `<span class="d-inline-flex align-items-center gap-2 border border-primary-subtle rounded-pill ps-3 pe-1 py-1 bg-body"><i class="bi bi-star-fill text-warning"></i><b class="text-body">${esc(mine)}</b><button type="button" id="go-me" class="btn btn-sm btn-primary rounded-pill">My matches</button><button type="button" id="forget" class="btn btn-sm border-0" aria-label="Forget my name"><i class="bi bi-x-lg"></i></button></span>`;
  $('summary').innerHTML = sum;

  $('results').innerHTML = !list.length
    ? `<div class="card border-0 shadow-sm text-center p-5 rounded-4"><div class="display-3">🏸</div><h2 class="h4 mt-2">No matches found</h2><p class="text-body-secondary">Try a different spelling, or clear the filters.</p><div><button class="btn btn-primary rounded-pill px-4" type="button" id="reset-empty">Show everything</button></div></div>`
    : state.view === 'court' ? courtsView(list, next) : timeline(list, next);
  writeUrl();
}

// ---------- filter sheet ----------
function buildSheet() {
  $('groups').innerHTML = FILTERS.map((f) => {
    const all = new Map();
    for (const m of data.matches) for (const v of [].concat(f.of(m))) all.set(v, (all.get(v) ?? 0) + 1);
    const order = f.key === 'when' ? ['Morning', 'Afternoon', 'Evening'] : [...all.keys()].sort(f.key === 'team' ? (a, b) => teamName(a).localeCompare(teamName(b)) : num);
    const values = order.filter((v) => all.has(v));
    if (values.length < 2) return '';
    return `<div><div class="group-title"><i class="bi bi-${f.icon} me-2"></i>${f.label}</div><div class="d-flex flex-wrap gap-2">${values.map((v) => {
      const label = f.key === 'team' ? teamName(v) : v;
      const pre = f.key === 'team' ? logo(v, label, true) : '';
      return `<button type="button" class="btn btn-sm opt d-inline-flex align-items-center gap-2 px-3 py-2" data-f="${f.key}" data-v="${esc(v)}">${pre}${esc(label)}</button>`;
    }).join('')}</div></div>`;
  }).join('');
}
function syncSheet() {
  for (const b of $('groups').querySelectorAll('.opt')) {
    const on = state.sel[b.dataset.f].has(b.dataset.v);
    b.classList.toggle('btn-primary', on);
    b.classList.toggle('btn-outline-secondary', !on);
  }
  const n = data.matches.filter(matches).length;
  $('apply').textContent = `Show ${n} match${n === 1 ? '' : 'es'}`;
}

// ---------- calendar ----------
function icsFor(m) {
  const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const end = new Date(Date.parse(m.start) + (data.tournament.matchMinutes ?? 30) * 60000);
  const fold = (s) => s.replace(/[\\;,]/g, (c) => '\\' + c);
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Match schedule//EN', 'BEGIN:VEVENT', `UID:${m.start}-${m.court}-${m.game}@schedule`, `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(m.start)}`, `DTEND:${stamp(end)}`, `SUMMARY:${fold(`${m.level}: ${m.a.name} vs ${m.b.name}`)}`,
    `LOCATION:${fold([m.court, data.tournament.venue].filter(Boolean).join(', '))}`, `DESCRIPTION:${fold(`${data.tournament.name}${m.game ? ' - Game ' + m.game : ''}`)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
function downloadIcs(m) {
  const url = URL.createObjectURL(new Blob([icsFor(m)], { type: 'text/calendar' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `match-${m.game ?? m.time.replace(/\W+/g, '')}.ics` });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------- wiring ----------
function resetAll() {
  state.q = '';
  for (const f of FILTERS) state.sel[f.key].clear();
  $('q').value = '';
  render();
}
function setTheme(t) {
  document.documentElement.setAttribute('data-bs-theme', t);
  store.set('sched.theme', t);
  document.querySelector('meta[name=theme-color]').content = t === 'dark' ? '#0b1220' : '#0f766e';
  $('theme').innerHTML = `<i class="bi bi-${t === 'dark' ? 'sun-fill' : 'moon-stars-fill'}"></i>`;
}

function wire() {
  sheet = bootstrap.Offcanvas.getOrCreateInstance($('sheet'));
  let t;
  $('q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value.trim(); render(); }, 120); });
  $('clear').addEventListener('click', () => { state.q = ''; $('q').value = ''; render(); $('q').focus(); });
  $('v-time').addEventListener('click', () => { state.view = 'time'; render(); });
  $('v-court').addEventListener('click', () => { state.view = 'court'; render(); });
  $('open-filters').addEventListener('click', () => { buildSheet(); syncSheet(); sheet.show(); });
  $('reset').addEventListener('click', () => { for (const f of FILTERS) state.sel[f.key].clear(); syncSheet(); render(); });
  $('groups').addEventListener('click', (e) => {
    const b = e.target.closest('.opt'); if (!b) return;
    const s = state.sel[b.dataset.f];
    s.has(b.dataset.v) ? s.delete(b.dataset.v) : s.add(b.dataset.v);
    syncSheet(); render();
  });
  $('chips').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { state.sel[b.dataset.rm].delete(b.dataset.val); render(); } });
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#reset-all, #reset-empty')) return resetAll();
    if (t.closest('#pin')) { store.set('sched.me', state.q); return render(); }
    if (t.closest('#forget')) { store.set('sched.me', null); return render(); }
    if (t.closest('#go-me')) { state.q = store.get('sched.me') ?? ''; $('q').value = state.q; return render(); }
    const ics = t.closest('[data-ics]'); if (ics) downloadIcs(data.matches[Number(ics.dataset.ics)]);
  });
  $('theme').addEventListener('click', () => setTheme(document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark'));
}

async function init() {
  setTheme(document.documentElement.getAttribute('data-bs-theme') || 'light');
  try {
    data = await (await fetch('schedule.json', { cache: 'no-cache' })).json();
  } catch {
    $('results').innerHTML = '<div class="card border-0 shadow-sm text-center p-5 rounded-4"><div class="display-3">📡</div><h2 class="h4 mt-2">Could not load the schedule</h2><p class="text-body-secondary mb-0">Check your connection and refresh the page.</p></div>';
    return;
  }
  teamBy = new Map(data.teams.map((t) => [t.id, t]));
  const tn = data.tournament;
  document.title = `${tn.name} · Match schedule`;
  $('title').textContent = tn.name;
  const days = [...new Set(data.matches.map((m) => m.day))];
  $('meta').innerHTML = [days.length ? `<span><i class="bi bi-calendar-event me-2"></i>${esc(days.length > 1 ? days[0] + ' – ' + days.at(-1) : days[0])}</span>` : '', tn.venue ? `<span><i class="bi bi-geo-alt me-2"></i>${esc(tn.venue)}</span>` : ''].join('');
  const courts = new Set(data.matches.map((m) => m.court)).size;
  const stat = (n, l) => `<div class="stat glass"><b>${n}</b><span>${l}</span></div>`;
  $('stats').innerHTML = stat(data.matches.length, 'Matches') + stat(data.teams.length, 'Teams') + stat(courts, 'Courts');
  $('stamp').textContent = `Schedule as of ${new Date(data.exportedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;

  readUrl();
  if (!location.search && store.get('sched.me')) state.q = store.get('sched.me');
  $('q').value = state.q;
  wire();
  render();
}
init();
