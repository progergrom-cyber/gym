'use strict';
// Страница «Прогресс»: графики, посещения, история тренировок, замеры тела.

let measurements = [];
let stats = null;
let calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
const KIND_LETTER = { upper: 'В', lower: 'Н', full: 'Ф', glutes: 'Ж' };

// ---------- даты ----------

function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return addDays(x, -((x.getDay() + 6) % 7));
}
// Понедельники последних n недель, от старой к текущей
function lastWeeks(n) {
  const cur = mondayOf(new Date());
  return Array.from({ length: n }, (_, i) => addDays(cur, -7 * (n - 1 - i)));
}
function shortMonth(d) {
  return d.toLocaleDateString('ru-RU', { month: 'short' }).replace('.', '');
}
function weekRange(mon) {
  const sun = addDays(mon, 6);
  return `${mon.getDate()} ${shortMonth(mon)} – ${sun.getDate()} ${shortMonth(sun)}`;
}
function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b === 1) return forms[0];
  if (b >= 2 && b <= 4) return forms[1];
  return forms[2];
}
function fmtKg(v) {
  if (v >= 10000) return fmtNum(Math.round(v / 100) / 10) + ' т';
  return Math.round(v).toLocaleString('ru-RU') + ' кг';
}

// ---------- вкладки ----------

const TABS = ['charts', 'visits', 'history', 'body'];

function showTab(tab) {
  document.querySelectorAll('#tabs button').forEach(b =>
    b.classList.toggle('on', b.dataset.tab === tab));
  TABS.forEach(t => { $('#' + t).hidden = t !== tab; });
  history.replaceState(null, '', tab === 'charts' ? location.pathname : '#' + tab);
  redrawCanvases();
}
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) showTab(b.dataset.tab);
});

// ---------- общие элементы графиков ----------

function statTile(label, value, sub) {
  return `<div class="stat">
    <div class="stat-v">${value}</div>
    <div class="stat-l">${label}</div>
    ${sub ? `<div class="stat-s">${sub}</div>` : ''}
  </div>`;
}

// Столбчатая диаграмма. items: [{label, value, tip}]. Нажатие на столбец
// показывает подпись над графиком.
function barChart(el, items, { goal, goalLabel } = {}) {
  const max = Math.max(goal || 0, ...items.map(i => i.value), 1);
  el.innerHTML = `
    <div class="chart-caption"></div>
    <div class="bars" style="grid-template-columns:repeat(${items.length},1fr)">
      ${goal ? `<div class="goal-line" style="bottom:${goal / max * 100}%"><span>${esc(goalLabel)}</span></div>` : ''}
      ${items.map((it, i) => `
        <button type="button" class="bar-col" data-i="${i}" aria-label="${esc(it.tip)}">
          <span class="bar" style="height:${it.value ? Math.max(3, it.value / max * 100) : 0}%"></span>
        </button>`).join('')}
    </div>
    <div class="bar-x" style="grid-template-columns:repeat(${items.length},1fr)">
      ${items.map((it, i) => `<span>${(items.length - 1 - i) % 3 === 0 ? esc(it.label) : ''}</span>`).join('')}
    </div>`;
  const caption = el.querySelector('.chart-caption');
  const select = i => {
    el.querySelectorAll('.bar-col').forEach((b, j) => b.classList.toggle('sel', j === i));
    caption.textContent = items[i].tip;
  };
  el.querySelector('.bars').addEventListener('click', e => {
    const b = e.target.closest('.bar-col');
    if (b) select(Number(b.dataset.i));
  });
  select(items.length - 1);
}

// Линейный график на canvas. pts: [{t, v, date}], opts.onSelect(i) — при нажатии.
function drawLine(canvas, pts, opts = {}) {
  canvas._line = { pts, opts };
  if (!canvas._tap) {
    canvas._tap = true;
    canvas.addEventListener('click', e => {
      const st = canvas._line;
      if (!st || !canvas._xs || !canvas._xs.length) return;
      const px = e.clientX - canvas.getBoundingClientRect().left;
      let best = 0;
      canvas._xs.forEach((x, i) => { if (Math.abs(x - px) < Math.abs(canvas._xs[best] - px)) best = i; });
      st.opts.selected = best;
      drawLine(canvas, st.pts, st.opts);
      if (st.opts.onSelect) st.opts.onSelect(best);
    });
  }
  if (canvas.offsetParent === null) return;   // вкладка скрыта — нарисуем при показе

  const css = getComputedStyle(document.documentElement);
  const color = name => css.getPropertyValue(name).trim();
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '12px system-ui, sans-serif';
  canvas._xs = [];

  if (pts.length < 2) {
    ctx.fillStyle = color('--muted');
    ctx.textAlign = 'center';
    ctx.fillText(opts.emptyText || 'Нужно минимум 2 значения', w / 2, h / 2);
    return;
  }

  const pad = { l: 40, r: 14, t: 14, b: 24 };
  let min = Math.min(...pts.map(p => p.v));
  let max = Math.max(...pts.map(p => p.v));
  const span = Math.max(max - min, 2);
  min = Math.floor(min - span * 0.15);
  max = Math.ceil(max + span * 0.15);
  if (max - min >= 6) max = min + Math.ceil((max - min) / 3) * 3;   // ровные деления сетки
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const x = p => pad.l + (t1 === t0 ? 0.5 : (p.t - t0) / (t1 - t0)) * (w - pad.l - pad.r);
  const y = v => pad.t + (1 - (v - min) / (max - min)) * (h - pad.t - pad.b);

  // Сетка и подписи оси значений
  ctx.strokeStyle = color('--line');
  ctx.fillStyle = color('--muted');
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 3; i++) {
    const v = min + (max - min) * i / 3;
    ctx.beginPath();
    ctx.moveTo(pad.l, y(v));
    ctx.lineTo(w - pad.r, y(v));
    ctx.stroke();
    ctx.fillText(fmtNum(max - min >= 6 ? Math.round(v) : Math.round(v * 10) / 10), pad.l - 6, y(v));
  }
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(fmtDate(pts[0].date, false), pad.l, h - 4);
  ctx.textAlign = 'right';
  ctx.fillText(fmtDate(pts[pts.length - 1].date, false), w - pad.r, h - 4);

  const sel = opts.selected ?? pts.length - 1;
  // Вертикальная линия у выбранной точки
  ctx.strokeStyle = color('--muted');
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(x(pts[sel]), pad.t);
  ctx.lineTo(x(pts[sel]), h - pad.b);
  ctx.stroke();
  ctx.setLineDash([]);

  // Линия
  ctx.strokeStyle = color('--accent');
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(x(p), y(p.v)) : ctx.moveTo(x(p), y(p.v))));
  ctx.stroke();

  // Точки с «кольцом» цвета фона
  pts.forEach((p, i) => {
    const r = i === sel ? 6 : 4;
    ctx.beginPath();
    ctx.arc(x(p), y(p.v), r + 2, 0, Math.PI * 2);
    ctx.fillStyle = color('--surface');
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x(p), y(p.v), r, 0, Math.PI * 2);
    ctx.fillStyle = color('--accent');
    ctx.fill();
    canvas._xs.push(x(p));
  });
}

function redrawCanvases() {
  for (const id of ['ex-chart', 'chart']) {
    const c = $('#' + id);
    if (c && c._line) drawLine(c, c._line.pts, c._line.opts);
  }
}
window.addEventListener('resize', redrawCanvases);

// ---------- вкладка «Графики» ----------

function renderCharts() {
  const ws = stats.workouts;
  const today = new Date();
  const d7 = toISO(addDays(today, -6));
  const d14 = toISO(addDays(today, -13));
  const d30 = toISO(addDays(today, -29));
  const sum = (list, f) => list.reduce((n, w) => n + f(w), 0);
  const last7 = ws.filter(w => w.date >= d7);
  const prev7 = ws.filter(w => w.date >= d14 && w.date < d7);
  const vol7 = sum(last7, w => w.volume);
  const volPrev = sum(prev7, w => w.volume);
  let delta = '';
  if (volPrev > 0) {
    const pct = Math.round((vol7 - volPrev) / volPrev * 100);
    delta = `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}% к прошлым 7 дням`;
  }

  $('#charts-stats').innerHTML =
    statTile('тренировок всего', ws.length) +
    statTile('за 30 дней', ws.filter(w => w.date >= d30).length) +
    statTile('тоннаж за 7 дней', vol7 ? fmtKg(vol7) : '0', delta) +
    statTile('подходов за 7 дней', sum(last7, w => w.sets));

  // Тоннаж по неделям
  const weeks = lastWeeks(12);
  barChart($('#volume-chart'), weeks.map(mon => {
    const from = toISO(mon);
    const to = toISO(addDays(mon, 6));
    const v = sum(ws.filter(w => w.date >= from && w.date <= to), w => w.volume);
    return {
      label: `${mon.getDate()}.${String(mon.getMonth() + 1).padStart(2, '0')}`,
      value: v,
      tip: `${weekRange(mon)}: ${v ? fmtKg(v) : 'тренировок не было'}`,
    };
  }));

  // Выбор упражнения
  const sel = $('#ex-select');
  if (!stats.exercises.length) {
    sel.innerHTML = '<option>Пока нет данных</option>';
    sel.disabled = true;
  } else {
    const prev = sel.value;
    sel.disabled = false;
    sel.innerHTML = stats.exercises.map(e =>
      `<option value="${e.id}">${esc(e.name)} (${e.points.length})</option>`).join('');
    if (stats.exercises.some(e => String(e.id) === prev)) sel.value = prev;
  }
  renderExerciseChart();

  // Баланс мышц
  const rows = stats.muscles;
  const maxSets = Math.max(1, ...rows.map(r => r.sets));
  $('#muscle-bars').innerHTML = rows.length ? `<div class="hbars">${rows.map(r => `
    <div class="hbar-row ${r.sets ? '' : 'zero'}">
      <span class="hbar-l">${esc(r.label)}</span>
      <span class="hbar-track"><i style="width:${r.sets / maxSets * 100}%"></i></span>
      <span class="hbar-v">${r.sets}</span>
    </div>`).join('')}</div>` : '<p class="muted">Нет данных</p>';
}

function renderExerciseChart() {
  const ex = stats.exercises.find(e => String(e.id) === $('#ex-select').value);
  const canvas = $('#ex-chart');
  const caption = $('#ex-caption');
  if (!ex) {
    caption.textContent = '';
    drawLine(canvas, [], { emptyText: 'Графики появятся после первых тренировок' });
    return;
  }
  const pts = ex.points.map(p => ({ ...p, t: parseISO(p.date).getTime(), v: p.weight }));
  const first = pts[0].v;
  const last = pts[pts.length - 1].v;
  let summary = `${fmtNum(last)} кг`;
  if (pts.length > 1) {
    const diff = Math.round((last - first) * 10) / 10;
    const pct = first ? Math.round(diff / first * 100) : 0;
    summary = `Было ${fmtNum(first)} → стало ${fmtNum(last)} кг` +
      (diff ? ` (${diff > 0 ? '+' : ''}${fmtNum(diff)} кг, ${pct > 0 ? '+' : ''}${pct}%)` : '');
  }
  const show = i => {
    const p = pts[i];
    caption.innerHTML = `<b>${esc(summary)}</b><br><span class="muted">${esc(fmtDate(p.date))}: ` +
      `${fmtNum(p.weight)} кг × ${p.reps}</span>`;
  };
  show(pts.length - 1);
  drawLine(canvas, pts, {
    emptyText: 'Сделайте это упражнение ещё раз, чтобы увидеть линию',
    onSelect: show,
  });
}
$('#ex-select').addEventListener('change', renderExerciseChart);

// ---------- вкладка «Посещения» ----------

function visitMap() {
  const map = new Map();   // дата -> набор типов тренировок
  for (const w of stats.workouts) {
    if (!map.has(w.date)) map.set(w.date, new Set());
    map.get(w.date).add(w.kind);
  }
  return map;
}

function renderVisits() {
  const map = visitMap();
  const goal = stats.freq || 3;
  const perWeek = new Map();
  for (const d of map.keys()) {
    const k = toISO(mondayOf(parseISO(d)));
    perWeek.set(k, (perWeek.get(k) || 0) + 1);
  }
  const curMon = mondayOf(new Date());
  const thisWeek = perWeek.get(toISO(curMon)) || 0;

  // Сколько недель подряд выполнена цель (текущая неделя считается, если цель уже есть)
  let streak = 0;
  let mon = thisWeek >= goal ? curMon : addDays(curMon, -7);
  while ((perWeek.get(toISO(mon)) || 0) >= goal) {
    streak++;
    mon = addDays(mon, -7);
  }

  const monthPrefix = todayISO().slice(0, 7);
  const thisMonth = [...map.keys()].filter(d => d.startsWith(monthPrefix)).length;

  $('#visit-stats').innerHTML =
    statTile('на этой неделе', `${thisWeek} <small>из ${goal}</small>`,
      `<span class="mini-progress"><i style="width:${Math.min(100, thisWeek / goal * 100)}%"></i></span>`) +
    statTile(plural(streak, ['неделя подряд', 'недели подряд', 'недель подряд']) + ' с целью', streak) +
    statTile('в этом месяце', thisMonth) +
    statTile('посещений всего', map.size);

  renderCalendar(map);

  barChart($('#visits-chart'), lastWeeks(12).map(m => {
    const v = perWeek.get(toISO(m)) || 0;
    return {
      label: `${m.getDate()}.${String(m.getMonth() + 1).padStart(2, '0')}`,
      value: v,
      tip: `${weekRange(m)}: ${v} ${plural(v, ['посещение', 'посещения', 'посещений'])}`,
    };
  }), { goal, goalLabel: `цель ${goal}` });
}

function renderCalendar(map = visitMap()) {
  const y = calMonth.getFullYear();
  const m = calMonth.getMonth();
  const title = calMonth.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', '');
  $('#cal-title').textContent = title[0].toUpperCase() + title.slice(1);
  const offset = (new Date(y, m, 1).getDay() + 6) % 7;
  const days = new Date(y, m + 1, 0).getDate();
  const today = todayISO();
  let count = 0;
  let html = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(d => `<span class="cal-w">${d}</span>`).join('');
  html += '<span></span>'.repeat(offset);
  for (let d = 1; d <= days; d++) {
    const iso = toISO(new Date(y, m, d));
    const kinds = map.get(iso);
    if (kinds) count++;
    const letters = kinds ? [...kinds].map(k => KIND_LETTER[k] || '•').join('') : '';
    html += `<span class="cal-d ${kinds ? 'v' : ''} ${iso === today ? 'today' : ''} ${iso > today ? 'future' : ''}"
      ${kinds ? `title="${esc([...kinds].map(k => stats.workouts.find(w => w.kind === k).kind_label).join(', '))}"` : ''}>
      ${d}${letters ? `<small>${letters}</small>` : ''}</span>`;
  }
  $('#cal').innerHTML = html;
  $('#cal-legend').textContent = `В этом месяце: ${count} ${plural(count, ['посещение', 'посещения', 'посещений'])}. ` +
    'В — верх, Н — низ, Ф — фулбади, Ж — жопа';
  const now = new Date();
  $('#cal-next').disabled = y > now.getFullYear() || (y === now.getFullYear() && m >= now.getMonth());
}

$('#cal-prev').addEventListener('click', () => {
  calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1);
  renderCalendar();
});
$('#cal-next').addEventListener('click', () => {
  calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1);
  renderCalendar();
});

async function loadStats() {
  try {
    stats = await api('GET', '/api/stats');
    renderCharts();
    renderVisits();
  } catch (e) {
    const msg = `<div class="note warn">${esc(e.message)}</div>`;
    $('#charts-stats').innerHTML = msg;
    $('#visit-stats').innerHTML = msg;
  }
}

// ---------- вкладка «История» ----------

async function loadWorkouts() {
  const pending = store.get('pending', []).length;
  $('#pending-note').innerHTML = pending
    ? `<div class="note warn">Тренировок ждут отправки на сервер: ${pending}.
       Отправятся автоматически, когда появится интернет.</div>`
    : '';
  try {
    const { items } = await api('GET', '/api/workouts');
    renderWorkouts(items);
  } catch (e) {
    $('#workouts').innerHTML = `<div class="note warn">${esc(e.message)}</div>`;
  }
}

function renderWorkouts(items) {
  if (!items.length) {
    $('#workouts').innerHTML = '<p class="muted">Пока нет завершённых тренировок.</p>';
    return;
  }
  $('#workouts').innerHTML = items.map(w => `
    <article class="card" data-id="${w.id}">
      <div class="row" style="padding:0">
        <div class="grow">
          <h3>${esc(fmtDate(w.date))} · ${esc(w.kind_label)}</h3>
          <div class="small muted">${w.exercises.length} упр. ·
            ${w.exercises.reduce((n, e) => n + e.sets.length, 0)} подходов</div>
        </div>
        <button class="icon-btn del-w" type="button" aria-label="Удалить тренировку">×</button>
      </div>
      ${w.exercises.map(ex => `
        <div class="workout-ex"><b>${esc(ex.name)}</b><br>
          <span class="muted">${ex.sets.map(s => `${fmtNum(s.weight)}×${s.reps}`).join(', ')}</span>
        </div>`).join('')}
    </article>`).join('');
}

$('#workouts').addEventListener('click', async e => {
  if (!e.target.closest('.del-w')) return;
  const id = e.target.closest('[data-id]').dataset.id;
  if (!confirm('Удалить эту тренировку из истории?')) return;
  try {
    await api('DELETE', `/api/workouts/${id}`);
    loadWorkouts();
    loadStats();
  } catch (err) { toast(err.message); }
});

// ---------- вкладка «Тело» ----------

async function loadMeasurements() {
  try {
    const { items } = await api('GET', '/api/measurements');
    measurements = items;
    renderMeasurements();
    renderWeightChart();
  } catch (e) {
    $('#m-list').innerHTML = `<p class="muted">${esc(e.message)}</p>`;
  }
}

function renderWeightChart() {
  const pts = measurements.map(m => ({ t: parseISO(m.date).getTime(), v: m.weight, date: m.date }));
  const show = i => {
    $('#w-caption').innerHTML = pts.length
      ? `<span class="muted">${esc(fmtDate(pts[i].date))}: </span><b>${fmtNum(pts[i].v)} кг</b>` : '';
  };
  if (pts.length) show(pts.length - 1);
  drawLine($('#chart'), pts, { emptyText: 'График появится после двух замеров', onSelect: show });
}

function renderMeasurements() {
  if (!measurements.length) {
    $('#m-list').innerHTML = '<p class="muted">Замеров пока нет. Добавьте первый — нужен хотя бы вес.</p>';
    return;
  }
  const rows = measurements.map((m, i) => {
    const prev = measurements[i - 1];
    let delta = '';
    if (prev) {
      const d = Math.round((m.weight - prev.weight) * 10) / 10;
      if (d > 0) delta = `<span class="delta-up">▲ ${fmtNum(d)}</span>`;
      else if (d < 0) delta = `<span class="delta-down">▼ ${fmtNum(-d)}</span>`;
      else delta = '<span class="muted">=</span>';
    }
    const extra = [
      m.fat_pct != null ? `жир ${fmtNum(m.fat_pct)}%` : '',
      m.muscle_kg != null ? `мышцы ${fmtNum(m.muscle_kg)} кг` : '',
      m.bmr != null ? `обмен ${fmtNum(m.bmr)} ккал` : '',
    ].filter(Boolean).join(' · ');
    return `
      <div class="row" data-id="${m.id}">
        <div class="grow">
          <div><b>${fmtNum(m.weight)} кг</b> ${delta}</div>
          <div class="small muted">${esc(fmtDate(m.date, false))}${extra ? ' · ' + extra : ''}</div>
        </div>
        <button class="icon-btn del-m" type="button" aria-label="Удалить замер">×</button>
      </div>`;
  });
  $('#m-list').innerHTML = rows.reverse().join('');
}

$('#m-list').addEventListener('click', async e => {
  if (!e.target.closest('.del-m')) return;
  const id = e.target.closest('[data-id]').dataset.id;
  if (!confirm('Удалить этот замер?')) return;
  try {
    await api('DELETE', `/api/measurements/${id}`);
    loadMeasurements();
  } catch (err) { toast(err.message); }
});

$('#add-toggle').addEventListener('click', () => {
  const form = $('#m-form');
  form.hidden = !form.hidden;
  if (!form.hidden) {
    form.date.value = todayISO();
    const last = measurements[measurements.length - 1];
    if (last) form.weight.placeholder = fmtNum(last.weight);
    form.weight.focus();
  }
});

$('#m-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  $('#m-error').textContent = '';
  try {
    await api('POST', '/api/measurements', {
      date: f.date.value, weight: f.weight.value, fat_pct: f.fat_pct.value,
      muscle_kg: f.muscle_kg.value, bmr: f.bmr.value,
    });
    f.reset();
    f.hidden = true;
    toast('Замер сохранён');
    loadMeasurements();
  } catch (err) {
    $('#m-error').textContent = err.message;
  }
});

// ---------- запуск ----------

renderNav('progress');
(async () => {
  try { await requireAuth(); } catch (e) { return; }
  await flushPending();
  const tab = location.hash.slice(1);
  showTab(TABS.includes(tab) ? tab : 'charts');
  loadStats();
  loadWorkouts();
  loadMeasurements();
})();
