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

  renderMuscleWeeks();
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

// ---------- нагрузка на мышцы за неделю ----------

let muscleWeek = null;   // индекс выбранной недели (по умолчанию — текущая)

// Схема тела: спереди и сзади. Каждая фигура — 100×200, мышцы — ключи из planner.MUSCLES.
const BODY_BASE = `
  <circle cx="50" cy="16" r="10"/><rect x="45" y="24" width="10" height="9" rx="3"/>
  <path d="M30 34 Q50 29 70 34 L68 92 Q50 99 32 92 Z"/>
  <path d="M32 90 Q50 98 68 90 L69 106 Q50 112 31 106 Z"/>
  <ellipse cx="24" cy="54" rx="6.5" ry="16"/><ellipse cx="76" cy="54" rx="6.5" ry="16"/>
  <ellipse cx="20" cy="84" rx="5" ry="14"/><ellipse cx="80" cy="84" rx="5" ry="14"/>
  <ellipse cx="41" cy="130" rx="9.5" ry="25"/><ellipse cx="59" cy="130" rx="9.5" ry="25"/>
  <ellipse cx="40" cy="173" rx="6.5" ry="20"/><ellipse cx="60" cy="173" rx="6.5" ry="20"/>`;
const BODY_FRONT = {
  delts_side: '<ellipse cx="29" cy="38" rx="7" ry="6"/><ellipse cx="71" cy="38" rx="7" ry="6"/>',
  chest: '<path d="M37 39 Q44 36 49 39 L49 52 Q42 55 36 50 Z"/><path d="M63 39 Q56 36 51 39 L51 52 Q58 55 64 50 Z"/>',
  biceps: '<ellipse cx="24" cy="55" rx="4.5" ry="11"/><ellipse cx="76" cy="55" rx="4.5" ry="11"/>',
  abs: '<rect x="43" y="57" width="14" height="32" rx="4"/>',
  quads: '<ellipse cx="41" cy="127" rx="8" ry="21"/><ellipse cx="59" cy="127" rx="8" ry="21"/>',
};
const BODY_BACK = {
  delts_rear: '<ellipse cx="29" cy="38" rx="7" ry="6"/><ellipse cx="71" cy="38" rx="7" ry="6"/>',
  back_mid: '<path d="M40 36 L60 36 L58 56 L42 56 Z"/>',
  back_lats: '<path d="M34 45 L41 50 L43 72 Q37 70 34 62 Z"/><path d="M66 45 L59 50 L57 72 Q63 70 66 62 Z"/>',
  triceps: '<ellipse cx="24" cy="55" rx="4.5" ry="11"/><ellipse cx="76" cy="55" rx="4.5" ry="11"/>',
  lower_back: '<rect x="44" y="60" width="12" height="28" rx="4"/>',
  glutes: '<ellipse cx="42" cy="101" rx="9" ry="8"/><ellipse cx="58" cy="101" rx="9" ry="8"/>',
  hamstrings: '<ellipse cx="41" cy="131" rx="7.5" ry="18"/><ellipse cx="59" cy="131" rx="7.5" ry="18"/>',
  calves: '<ellipse cx="40" cy="168" rx="5.5" ry="13"/><ellipse cx="60" cy="168" rx="5.5" ry="13"/>',
};

function muscleLevel(sets, row) {
  if (!sets) return 'none';
  if (sets < row.lo) return 'low';
  if (sets > row.hi) return 'high';
  return 'ok';
}

function bodyFigure(x, label, parts, rows, wi) {
  const byKey = Object.fromEntries(rows.map(r => [r.muscle, r]));
  const muscles = Object.entries(parts).map(([k, shapes]) => {
    const r = byKey[k];
    const sets = r ? r.sets[wi] : 0;
    const title = r ? `${r.label}: ${sets} ${plural(sets, ['подход', 'подхода', 'подходов'])}` : '';
    return `<g class="m ${r ? muscleLevel(sets, r) : 'none'}"><title>${esc(title)}</title>${shapes}</g>`;
  }).join('');
  return `<g transform="translate(${x} 0)"><g class="base">${BODY_BASE}</g>${muscles}
    <text x="50" y="205">${label}</text></g>`;
}

function renderMuscleWeeks() {
  const mw = stats.muscle_weeks;
  if (muscleWeek === null || muscleWeek >= mw.weeks.length) muscleWeek = mw.weeks.length - 1;
  const wi = muscleWeek;
  $('#mw-weeks').innerHTML = mw.weeks.map((w, i) => {
    const d = parseISO(w);
    const label = i === mw.weeks.length - 1 ? 'Эта' : `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
    return `<button type="button" data-w="${i}" class="${i === wi ? 'on' : ''}">${label}</button>`;
  }).join('');

  const rows = mw.rows;
  $('#body-map').innerHTML = `<svg viewBox="0 0 220 210" role="img" aria-label="Схема нагрузки на мышцы">
    ${bodyFigure(5, 'спереди', BODY_FRONT, rows, wi)}${bodyFigure(115, 'сзади', BODY_BACK, rows, wi)}</svg>`;

  const level = r => muscleLevel(r.sets[wi], r);
  const names = lvl => rows.filter(r => level(r) === lvl).map(r => r.label.split(':')[0].split(' (')[0].toLowerCase());
  const ok = rows.filter(r => level(r) === 'ok').length;
  const lacking = [...new Set([...names('none'), ...names('low')])];
  const mon = parseISO(mw.weeks[wi]);
  const current = wi === mw.weeks.length - 1;
  let text = `<b>${esc(weekRange(mon))}${current ? ' (неделя ещё идёт)' : ''}</b><br>` +
    `В норме ${ok} из ${rows.length} групп.`;
  if (lacking.length) text += ` Не хватает: ${esc(lacking.slice(0, 5).join(', '))}${lacking.length > 5 ? '…' : '.'}`;
  if (names('high').length) text += ` Многовато: ${esc(names('high').join(', '))}.`;
  $('#mw-caption').innerHTML = text;

  const sorted = [...rows].sort((a, b) => b.sets[wi] - a.sets[wi]);
  $('#muscle-bars').innerHTML = `<div class="hbars">${sorted.map(r => {
    const sets = r.sets[wi];
    const scale = Math.max(r.hi * 1.25, sets, 1);
    const lvl = level(r);
    return `<div class="hbar-row ${sets ? '' : 'zero'}" title="Норма ${r.lo}–${r.hi} подходов в неделю">
      <span class="hbar-l">${esc(r.label)}</span>
      <span class="hbar-track">
        <span class="norm" style="left:${r.lo / scale * 100}%;width:${(r.hi - r.lo) / scale * 100}%"></span>
        <i class="${lvl}" style="width:${sets / scale * 100}%"></i></span>
      <span class="hbar-v ${lvl}">${sets}</span>
    </div>`;
  }).join('')}</div>`;
}

$('#mw-weeks').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  muscleWeek = Number(b.dataset.w);
  renderMuscleWeeks();
});

// ---------- итоги месяца (картинка, чтобы поделиться) ----------

let summaryMonth = (() => {
  const d = new Date();
  // В первые дни месяца интереснее итоги прошлого
  if (d.getDate() <= 5) d.setMonth(d.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
})();
let summary = null;

function shiftMonth(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function loadSummary() {
  const cur = todayISO().slice(0, 7);
  $('#sum-next').disabled = summaryMonth >= cur;
  try {
    summary = await api('GET', `/api/summary?month=${summaryMonth}`);
  } catch (e) {
    summary = null;
    $('#sum-title').textContent = 'Итоги месяца';
    $('#sum-actions').hidden = true;
    toast(e.message);
    return;
  }
  const t = summary.title;
  $('#sum-title').textContent = 'Итоги: ' + t;
  $('#sum-actions').hidden = !summary.workouts;
  drawSummary();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Обрезать текст с «…», чтобы влез в ширину
function fitText(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  while (text.length > 1 && ctx.measureText(text + '…').width > max) text = text.slice(0, -1);
  return text.trimEnd() + '…';
}

function cardKg(v) {
  return v >= 1000 ? `${fmtNum(Math.round(v / 100) / 10)} т` : `${Math.round(v)} кг`;
}

function drawSummary() {
  const s = summary;
  const canvas = $('#sum-card');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const css = getComputedStyle(document.documentElement);
  const c = name => css.getPropertyValue(name).trim();
  const font = (size, weight = 700) => `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const P = 80;

  ctx.fillStyle = c('--bg');
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W - 120, 120, 0, W - 120, 120, 700);
  glow.addColorStop(0, c('--accent-soft'));
  glow.addColorStop(1, 'transparent');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = c('--accent');
  ctx.font = font(34);
  ctx.fillText('ИТОГИ МЕСЯЦА', P, 130);
  ctx.fillStyle = c('--text');
  ctx.font = font(92, 800);
  ctx.fillText(s.title[0].toUpperCase() + s.title.slice(1), P, 230);
  ctx.fillStyle = c('--muted');
  ctx.font = font(38, 500);
  ctx.fillText('@' + s.username, P, 290);

  if (!s.workouts) {
    ctx.fillStyle = c('--muted');
    ctx.font = font(44, 600);
    ctx.fillText('В этом месяце тренировок не было', P, 520);
    ctx.font = font(36, 500);
    ctx.fillText('Самое время начать 💪', P, 590);
    return;
  }

  // Пока месяц идёт, сравнивать с целым прошлым месяцем нечестно
  const running = s.month === todayISO().slice(0, 7);
  const diff = (now, before, unit) => {
    if (running) return '';
    if (!before) return '';
    const d = now - before;
    if (!d) return 'как в прошлом месяце';
    return `${d > 0 ? '▲' : '▼'} ${unit(Math.abs(d))} к прошлому`;
  };
  const tiles = [
    [String(s.visits), plural(s.visits, ['посещение', 'посещения', 'посещений']),
      diff(s.visits, s.prev.visits, n => n)],
    [cardKg(s.volume), 'общий тоннаж', diff(s.volume, s.prev.volume, cardKg)],
    [String(s.sets), plural(s.sets, ['подход', 'подхода', 'подходов']), running ? 'месяц ещё идёт' : ''],
    [String(s.records_count), plural(s.records_count, ['рекорд', 'рекорда', 'рекордов']),
      s.weeks_goal ? `${s.weeks_goal} ${plural(s.weeks_goal, ['неделя', 'недели', 'недель'])} с целью` : ''],
  ];
  const tw = (W - P * 2 - 30) / 2;
  const th = 230;
  tiles.forEach(([value, label, sub], i) => {
    const x = P + (i % 2) * (tw + 30);
    const y = 350 + Math.floor(i / 2) * (th + 30);
    ctx.fillStyle = c('--surface');
    roundRect(ctx, x, y, tw, th, 36);
    ctx.fill();
    ctx.fillStyle = c('--accent');
    ctx.font = font(84, 800);
    ctx.fillText(fitText(ctx, value, tw - 80), x + 40, y + 105);
    ctx.fillStyle = c('--text');
    ctx.font = font(34, 600);
    ctx.fillText(label, x + 40, y + 155);
    if (sub) {
      ctx.fillStyle = c('--muted');
      ctx.font = font(28, 500);
      ctx.fillText(fitText(ctx, sub, tw - 80), x + 40, y + 198);
    }
  });

  let y = 920;
  ctx.fillStyle = c('--text');
  ctx.font = font(40, 800);
  ctx.fillText(s.records.length ? 'Лучшие рекорды' : 'Рекорды ещё впереди 💪', P, y);
  y += 30;
  s.records.slice(0, 3).forEach(r => {
    y += 70;
    const right = `${fmtNum(r.from)} → ${fmtNum(r.to)} кг`;
    ctx.font = font(36, 700);
    ctx.textAlign = 'right';
    ctx.fillStyle = c('--accent');
    ctx.fillText(right, W - P, y);
    const rw = ctx.measureText(right).width;
    ctx.textAlign = 'left';
    ctx.fillStyle = c('--text');
    ctx.font = font(36, 500);
    ctx.fillText(fitText(ctx, '⭐ ' + r.name, W - P * 2 - rw - 30), P, y);
  });

  ctx.fillStyle = c('--muted');
  ctx.font = font(32, 500);
  ctx.textAlign = 'left';
  if (s.favorite) ctx.fillText(`Чаще всего: ${s.favorite}`, P, H - 90);
  ctx.textAlign = 'right';
  ctx.fillText('🏋️ Тренер для зала', W - P, H - 90);
  ctx.textAlign = 'left';
}

function summaryFile() {
  return new Promise((resolve, reject) => {
    $('#sum-card').toBlob(blob => blob
      ? resolve(new File([blob], `itogi-${summaryMonth}.png`, { type: 'image/png' }))
      : reject(new Error('Не удалось сохранить картинку')), 'image/png');
  });
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#sum-share').addEventListener('click', async () => {
  try {
    const file = await summaryFile();
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: `Итоги: ${summary.title}` });
    } else {
      downloadFile(file);
      toast('Телефон не умеет делиться картинкой — сохранили файл');
    }
  } catch (e) {
    if (e.name !== 'AbortError') toast(e.message);
  }
});
$('#sum-save').addEventListener('click', async () => {
  try { downloadFile(await summaryFile()); } catch (e) { toast(e.message); }
});
$('#sum-prev').addEventListener('click', () => { summaryMonth = shiftMonth(summaryMonth, -1); loadSummary(); });
$('#sum-next').addEventListener('click', () => { summaryMonth = shiftMonth(summaryMonth, 1); loadSummary(); });

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
  loadSummary();
  loadWorkouts();
  loadMeasurements();
})();
