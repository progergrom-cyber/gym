'use strict';
// Страница «Прогресс»: история тренировок, замеры тела, график веса.

let measurements = [];

// ---------- вкладки ----------

function showTab(tab) {
  document.querySelectorAll('#tabs button').forEach(b =>
    b.classList.toggle('on', b.dataset.tab === tab));
  $('#history').hidden = tab !== 'history';
  $('#body').hidden = tab !== 'body';
  history.replaceState(null, '', tab === 'body' ? '#body' : location.pathname);
  if (tab === 'body') drawChart();
}
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) showTab(b.dataset.tab);
});

// ---------- тренировки ----------

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
      <div class="row" style="padding-top:0">
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
  } catch (err) { toast(err.message); }
});

// ---------- замеры ----------

async function loadMeasurements() {
  try {
    const { items } = await api('GET', '/api/measurements');
    measurements = items;
    renderMeasurements();
    drawChart();
  } catch (e) {
    $('#m-list').innerHTML = `<p class="muted">${esc(e.message)}</p>`;
  }
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

// ---------- график веса (рисуем сами, без библиотек) ----------

function drawChart() {
  const canvas = $('#chart');
  if (!canvas || canvas.offsetParent === null) return;
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
  ctx.font = '13px system-ui, sans-serif';

  const pts = measurements.map(m => ({ t: Date.parse(m.date), v: m.weight, date: m.date }));
  if (pts.length < 2) {
    ctx.fillStyle = color('--muted');
    ctx.textAlign = 'center';
    ctx.fillText('График появится после двух замеров', w / 2, h / 2);
    return;
  }

  const pad = { l: 40, r: 14, t: 16, b: 26 };
  let min = Math.min(...pts.map(p => p.v));
  let max = Math.max(...pts.map(p => p.v));
  min = Math.floor(min - 1);
  max = Math.ceil(max + 1);
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const x = p => pad.l + (t1 === t0 ? 0.5 : (p.t - t0) / (t1 - t0)) * (w - pad.l - pad.r);
  const y = v => pad.t + (1 - (v - min) / (max - min)) * (h - pad.t - pad.b);

  // Сетка и подписи по оси веса
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
    ctx.fillText(fmtNum(Math.round(v * 10) / 10), pad.l - 6, y(v));
  }
  // Даты: первая и последняя
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(fmtDate(pts[0].date, false), pad.l, h - 6);
  ctx.textAlign = 'right';
  ctx.fillText(fmtDate(pts[pts.length - 1].date, false), w - pad.r, h - 6);

  // Линия
  ctx.strokeStyle = color('--accent');
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(x(p), y(p.v)) : ctx.moveTo(x(p), y(p.v))));
  ctx.stroke();
  ctx.fillStyle = color('--accent');
  pts.forEach(p => {
    ctx.beginPath();
    ctx.arc(x(p), y(p.v), 4, 0, Math.PI * 2);
    ctx.fill();
  });
}
window.addEventListener('resize', drawChart);

// ---------- запуск ----------

renderNav('progress');
(async () => {
  try { await requireAuth(); } catch (e) { return; }
  await flushPending();
  showTab(location.hash === '#body' ? 'body' : 'history');
  loadWorkouts();
  loadMeasurements();
})();
