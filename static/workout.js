'use strict';
// Страница «Тренировка» в стиле «Фокус»: на главной — совет на сегодня и
// кнопка «Начать», во время тренировки — одно упражнение на весь экран.

const MINUTES = [30, 45, 60, 90];
const KINDS = { upper: 'Верх', lower: 'Низ', full: 'Фулбади', glutes: 'Жопа' };
const KIND_HINTS = {
  upper: 'грудь, спина, руки', lower: 'ноги целиком',
  full: 'всё тело', glutes: 'ягодицы и задняя поверхность бедра',
};

const root = $('#app');
let me = null;
let plan = store.get('plan');   // текущий план хранится в телефоне

function save() { store.set('plan', plan); }

function initLog(item) {
  item.log = Array.from({ length: item.sets }, () => ({
    weight: item.weight ?? '', reps: '', done: false,
  }));
}

function setTitle(text) { $('#page-title').textContent = text; }

// Кольцо прогресса (неделя, таймер)
function ring(size, stroke, part, color, label) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const len = Math.max(0, Math.min(1, part)) * c;
  return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" style="stroke:var(--surface-3)" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" style="stroke:${color}" stroke-width="${stroke}"
      stroke-linecap="round" stroke-dasharray="${len} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text x="50%" y="50%" dy=".35em" text-anchor="middle" style="fill:var(--text)" font-size="${size / 4.2}"
      font-weight="800">${label}</text>
  </svg>`;
}

function daysAgo(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const n = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(y, m - 1, d)) / 86400000);
  if (n <= 0) return 'сегодня';
  if (n === 1) return 'вчера';
  if (n < 5) return `${n} дня назад`;
  return `${n} дней назад`;
}

function fmtKg(v) {
  if (v >= 10000) return fmtNum(Math.round(v / 100) / 10) + ' т';
  return Math.round(v).toLocaleString('ru-RU') + ' кг';
}

const KIND_LETTER = { upper: 'В', lower: 'Н', full: 'Ф', glutes: 'Ж' };

// Дашборд: полоска недели Пн–Вс и цифры
function renderWeek(week) {
  const [y, m, d] = week.monday.split('-').map(Number);
  const today = todayISO();
  const byDate = Object.fromEntries((week.days || []).map(x => [x.date, x.kinds]));
  const cells = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((name, i) => {
    const dt = new Date(y, m - 1, d + i);
    const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const kinds = byDate[iso];
    const cls = [kinds ? 'v' : '', iso === today ? 'now' : '', iso > today ? 'future' : ''].join(' ');
    return `<div class="wk-day"><span class="wk-name">${name}</span>
      <span class="wk-cell ${cls}">${kinds ? kinds.map(k => KIND_LETTER[k] || '•').join('') : dt.getDate()}</span></div>`;
  }).join('');
  const pct = Math.min(100, week.visits / week.goal * 100);
  return `
    <a class="week-strip" href="/progress#visits" aria-label="Посещения на этой неделе">${cells}</a>
    <div class="stats three">
      <div class="stat"><div class="stat-v">${week.visits}<small>/${week.goal}</small></div>
        <div class="stat-l">цель недели</div>
        <span class="mini-progress"><i style="width:${pct}%"></i></span></div>
      <div class="stat"><div class="stat-v">${week.volume ? fmtKg(week.volume) : '0'}</div>
        <div class="stat-l">тоннаж недели</div></div>
      <div class="stat"><div class="stat-v">${week.sets}</div>
        <div class="stat-l">подходов</div></div>
    </div>`;
}

function renderLast(last) {
  if (!last) return '';
  return `
    <a class="card last-card" href="/progress#history">
      <div class="small muted">Прошлая тренировка · ${esc(fmtDate(last.date))}</div>
      <div class="last-title"><b>${esc(last.kind_label)}</b>
        <span class="muted small">${last.exercises} упр. · ${last.sets} подх. · ${fmtKg(last.volume)}</span></div>
      ${last.records.map(r => `<div class="record">⭐ Рекорд: ${esc(r.name)} — <b>${fmtNum(r.weight)} кг</b>
        <span class="muted">(было ${fmtNum(r.prev)})</span></div>`).join('')}
    </a>`;
}

// ---------- главная ----------

function currentChoice() {
  const c = store.get('choice', {});
  const week = me && me.week;
  // Свой выбор типа держим только сегодня, назавтра снова советуем
  const kind = c.kindDate === todayISO() && KINDS[c.kind] ? c.kind
    : (week && week.suggest) || 'full';
  return { minutes: MINUTES.includes(c.minutes) ? c.minutes : 60, kind, own: kind !== (week && week.suggest) };
}

function renderSetup(message) {
  const p = (me && me.profile) || {};
  const week = (me && me.week) || null;
  const choice = currentChoice();
  const needProfile = me && (!p.height || !me.has_weight);
  const injuries = (p.injuries || []).map(i => INJURY_LABELS[i]).join(', ');
  setTitle(p.username ? `Привет, ${p.username}` : 'Тренировка');


  root.innerHTML = `
    ${message ? `<div class="note ok">${esc(message)}</div>` : ''}
    ${needProfile ? `<div class="note warn">Заполните рост в разделе
      <a href="/settings">Профиль</a> и вес в разделе <a href="/progress#body">Прогресс</a>.</div>` : ''}
    ${week && week.monday ? renderWeek(week) : ''}

    <div class="hero today-card">
      <div class="small muted">${choice.own ? 'Ваш выбор на сегодня' : 'Сегодня советуем'}</div>
      <div class="today-kind">${KINDS[choice.kind]}</div>
      <div class="small muted">${esc(KIND_HINTS[choice.kind])}${week && week.last
        ? ` · в прошлый раз: ${esc(week.last.kind_label)}, ${daysAgo(week.last.date)}` : ''}</div>
      <div class="chips-row" id="minutes" role="group" aria-label="Время тренировки">
        ${MINUTES.map(m => `<button type="button" data-v="${m}"
          class="chip-btn ${m === choice.minutes ? 'on' : ''}">${m}${m === choice.minutes ? ' мин' : ''}</button>`).join('')}
      </div>
      <button class="btn primary big" id="make" type="button">Начать</button>
      <button class="link-btn" id="other-kind" type="button">другой тип тренировки ›</button>
      <div class="tiles two" id="kind" hidden>
        ${Object.entries(KINDS).map(([k, label]) => `<button type="button" data-v="${k}"
          class="tile ${k === choice.kind ? 'on' : ''}"><b>${label}</b><small>${KIND_HINTS[k]}</small></button>`).join('')}
      </div>
    </div>

    ${week && week.last && week.last.exercises !== undefined ? renderLast(week.last) : ''}

    <a class="card profile-line" href="/settings">
      <div class="grow">
        <div style="font-weight:700">${esc(GOAL_LABELS[p.goal] || '—')}</div>
        <span class="chip">${p.freq || 3} раза в неделю</span>
        ${injuries ? `<span class="chip warn">⚠ ${esc(injuries)}</span>` : ''}
      </div>
      <span class="muted">›</span>
    </a>
    <p class="muted small center">Для составления плана нужен интернет.
      Готовый план откроется и в зале без связи.</p>`;

  $('#minutes').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const c = store.get('choice', {});
    c.minutes = Number(b.dataset.v);
    store.set('choice', c);
    renderSetup();
  });
  $('#other-kind').addEventListener('click', () => {
    $('#kind').hidden = !$('#kind').hidden;
  });
  $('#kind').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const c = store.get('choice', {});
    c.kind = b.dataset.v;
    c.kindDate = todayISO();
    store.set('choice', c);
    renderSetup();
  });
  $('#make').addEventListener('click', makePlan);
}

async function makePlan() {
  const btn = $('#make');
  const choice = currentChoice();
  btn.disabled = true;
  btn.textContent = 'Составляю план…';
  try {
    await flushPending();  // сначала отправим прошлую тренировку, если она ждёт
    const res = await api('POST', '/api/plan',
      { minutes: choice.minutes, kind: choice.kind, date: todayISO() });
    plan = res.plan;
    plan.items.forEach(initLog);
    plan.cur = -1;          // начинаем с разминки
    save();
    renderPlan();
    window.scrollTo(0, 0);
  } catch (e) {
    toast(e.message, 4000);
    btn.disabled = false;
    btn.textContent = 'Начать';
  }
}

// ---------- тренировка: одно упражнение на экран ----------

function isDone(item) { return item.log.length > 0 && item.log.every(s => s.done); }
function nextUnfinished(from) {
  for (let k = 1; k <= plan.items.length; k++) {
    const i = (from + k) % plan.items.length;
    if (!isDone(plan.items[i])) return i;
  }
  return -1;
}

// Заметка к упражнению («сиденье на 4»). Хранится за упражнением и
// покажется в следующий раз. Изменения уходят на сервер вместе с тренировкой.
function noteOf(item) {
  const changed = plan.notes || {};
  return item.exercise_id in changed ? changed[item.exercise_id] : (item.note || '');
}

function renderNote(item) {
  const note = noteOf(item);
  if (item.noteOpen) {
    return `<div class="note-edit">
      <textarea class="ex-note" rows="2" maxlength="300"
        placeholder="Например: сиденье на 4, спинка на 2">${esc(note)}</textarea>
      <button class="btn small primary note-done" type="button">Готово</button>
    </div>`;
  }
  return note ? `<button class="ex-note-view edit-note" type="button">📝 ${esc(note)}</button>` : '';
}

function progressBar() {
  return `<div class="seg-progress" role="group" aria-label="Упражнения плана">
    <button type="button" class="seg-step ${plan.cur === -1 ? 'cur' : 'done'}" data-go="-1"
      aria-label="Разминка"></button>
    ${plan.items.map((it, i) => {
      const done = it.log.filter(s => s.done).length;
      const cls = i === plan.cur ? 'cur' : isDone(it) ? 'done' : done ? 'part' : '';
      return `<button type="button" class="seg-step ${cls}" data-go="${i}"
        aria-label="${i + 1}. ${esc(it.name)}"></button>`;
    }).join('')}
  </div>`;
}

function renderWarmup() {
  const options = plan.warmup || [];
  const w = options[plan.warmup_idx || 0];
  const warnings = plan.warnings || [];
  return `
    ${w && w.photo ? `<button class="focus-photo ex-photo" type="button" data-photo="${esc(w.photo)}"
      aria-label="Открыть фото"><img src="${esc(w.photo)}" alt=""></button>` : ''}
    <div class="small muted">Шаг 1 · перед силовыми</div>
    <h2 class="focus-name">Разминка ~${plan.warmup_min} мин</h2>
    <div class="card" style="margin-top:8px">
      ${w ? `<b>5 минут: ${esc(w.name)}</b>${w.equipment ? `<div class="small muted">${esc(w.equipment)}</div>` : ''}`
        : '<b>5 минут лёгкого кардио</b><div class="small muted">дорожка, велотренажёр или эллипс</div>'}
      <div class="small" style="margin-top:8px">Темп лёгкий, можно разговаривать. Потом вращения в плечах,
        локтях, коленях. В базовых упражнениях первый подход можно сделать с половиной веса.</div>
      ${options.length > 1 ? '<button class="btn small ghost" type="button" id="warmup-next" style="margin-top:12px">Другой тренажёр</button>' : ''}
    </div>
    ${warnings.length ? `<details class="note warn"><summary>Подсказки к плану (${warnings.length})</summary>
      <ul>${warnings.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
    <button class="btn primary big" type="button" data-go="${plan.items.length ? 0 : -1}">
      ${plan.items.length ? 'К упражнениям ›' : 'В плане нет упражнений'}</button>
    <div class="small muted center" style="margin-top:10px">В плане ${plan.items.length} упражнений ·
      около ${planMinutes()} мин</div>`;
}

function planMinutes() {
  const sec = plan.warmup_min * 60 + plan.items.reduce((s, i) => s + i.seconds, 0);
  return Math.round(sec / 60);
}

function weightStep(item) { return /гантел/i.test(item.equipment || '') ? 1 : 2.5; }
function shown(v) { return typeof v === 'number' ? fmtNum(v) : (v ?? ''); }

function renderExercise(idx) {
  const item = plan.items[idx];
  const k = item.log.findIndex(s => !s.done);
  const doneSets = item.log.map((s, j) => ({ ...s, j })).filter(s => s.done);
  const started = doneSets.length > 0;
  const next = nextUnfinished(idx);
  const allDone = plan.items.every(isDone);

  // Значения по умолчанию для текущего подхода
  if (k >= 0) {
    const s = item.log[k];
    const prev = doneSets[doneSets.length - 1];
    if (s.weight === '' || s.weight == null) s.weight = prev ? prev.weight : (item.weight ?? '');
    if (s.reps === '' || s.reps == null) s.reps = prev ? prev.reps : item.rep_hi;
  }

  return `
  <article class="ex focus" data-i="${idx}">
    ${item.photo ? `<button class="focus-photo ex-photo" type="button" data-photo="${esc(item.photo)}"
      aria-label="Открыть фото тренажёра"><img src="${esc(item.photo)}" alt=""></button>` : ''}
    <div class="small muted">Упражнение ${idx + 1} из ${plan.items.length}</div>
    <h2 class="focus-name">${esc(item.name)}</h2>
    <div class="meta">${esc(item.equipment)}${item.equipment ? ' · ' : ''}${esc(item.muscle_label)}</div>
    <div class="presc">
      <span>${item.log.length} × ${item.rep_lo}–${item.rep_hi}</span>
      <span>отдых ${fmtSec(item.rest)}</span>
      <span>${item.kind === 'compound' ? 'база' : 'изоляция'}</span>
    </div>
    <div class="hint">${esc(item.hint)}</div>
    ${renderNote(item)}
    ${item.tips && item.tips.length ? `
      <details class="tips" ${item.tipsOpen ? 'open' : ''}>
        <summary>Как делать</summary>
        <ul>${item.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
      </details>` : ''}

    ${k >= 0 ? `
      <div class="set-title">Подход ${k + 1} из ${item.log.length}</div>
      <div class="steppers">
        <div class="stepper">
          <span class="stepper-label">Вес, кг</span>
          <div class="stepper-row">
            <button type="button" class="step" data-f="weight" data-d="-1" aria-label="Меньше вес">−</button>
            <input class="step-val" data-f="weight" inputmode="decimal" autocomplete="off"
              aria-label="Вес, кг" value="${esc(shown(item.log[k].weight))}" placeholder="0">
            <button type="button" class="step" data-f="weight" data-d="1" aria-label="Больше вес">+</button>
          </div>
        </div>
        <div class="stepper">
          <span class="stepper-label">Повторы</span>
          <div class="stepper-row">
            <button type="button" class="step" data-f="reps" data-d="-1" aria-label="Меньше повторов">−</button>
            <input class="step-val" data-f="reps" inputmode="numeric" autocomplete="off"
              aria-label="Повторы" value="${esc(shown(item.log[k].reps))}" placeholder="0">
            <button type="button" class="step" data-f="reps" data-d="1" aria-label="Больше повторов">+</button>
          </div>
        </div>
      </div>
      <button class="btn primary big set-done" type="button">Подход сделан ✓</button>`
    : `<div class="note ok">Все подходы сделаны 👍</div>`}

    ${doneSets.length ? `<div class="done-sets">
      ${doneSets.map(s => `<button type="button" class="done-chip" data-j="${s.j}"
        aria-label="Исправить подход ${s.j + 1}">${s.j + 1}: ${fmtNum(s.weight)} × ${s.reps} ✓</button>`).join('')}
      <div class="small muted" style="width:100%">Нажмите на подход, чтобы исправить</div>
    </div>` : ''}

    <div class="ex-actions">
      <button class="btn small ghost add-set" type="button">+ подход</button>
      ${started ? '' : '<button class="btn small ghost replace" type="button">Заменить</button>'}
      ${item.noteOpen || noteOf(item) ? '' : '<button class="btn small ghost edit-note" type="button">📝 Заметка</button>'}
      <button class="btn small ghost danger remove" type="button">Убрать</button>
    </div>

    <div class="nav-row">
      <button class="btn ghost" type="button" data-go="${idx - 1}">‹ Назад</button>
      ${next >= 0 && next !== idx ? `<button class="btn ghost next-btn" type="button" data-go="${next}">
        <span class="small muted">Дальше</span>${esc(plan.items[next].name)} ›</button>` : ''}
    </div>
  </article>
  <button class="btn ${allDone ? 'primary big' : 'ghost wide'}" id="finish" type="button">Завершить тренировку</button>`;
}

function renderPlan() {
  if (plan.cur === undefined) {   // план от прошлой версии приложения
    plan.cur = plan.items.some(i => i.log.some(s => s.done)) ? Math.max(0, nextUnfinished(-1)) : -1;
  }
  if (plan.cur >= plan.items.length) plan.cur = plan.items.length - 1;
  setTitle(`${plan.kind_label} · ${plan.minutes} мин`);
  root.innerHTML = `
    <div class="focus-top">
      ${progressBar()}
      <button class="btn small ghost" type="button" id="overview">☰ Все упражнения</button>
    </div>
    ${plan.cur < 0 ? renderWarmup() : renderExercise(plan.cur)}`;
  const fin = $('#finish');
  if (fin) fin.addEventListener('click', finishWorkout);
  keepScreenOn();
}

function go(i) {
  plan.cur = Math.max(-1, Math.min(plan.items.length - 1, i));
  save();
  renderPlan();
  window.scrollTo(0, 0);
}

// Ввод значений и заметки — сохраняем сразу, чтобы ничего не потерялось
root.addEventListener('input', e => {
  if (!plan) return;
  const item = plan.items[plan.cur];
  if (!item) return;
  if (e.target.classList.contains('ex-note')) {
    plan.notes = plan.notes || {};
    plan.notes[item.exercise_id] = e.target.value;
    save();
  } else if (e.target.classList.contains('step-val')) {
    const s = item.log.find(x => !x.done);
    if (s) { s[e.target.dataset.f] = e.target.value; save(); }
  }
});

root.addEventListener('click', e => {
  if (!plan) return;
  const t = e.target;
  const goBtn = t.closest('[data-go]');
  if (goBtn) { go(Number(goBtn.dataset.go)); return; }
  const photo = t.closest('.ex-photo');
  if (photo) { showPhoto(photo.dataset.photo); return; }
  if (t.closest('#overview')) { openOverview(); return; }
  if (t.closest('#warmup-next')) {
    plan.warmup_idx = ((plan.warmup_idx || 0) + 1) % plan.warmup.length;
    save();
    renderPlan();
    return;
  }

  const idx = plan.cur;
  const item = plan.items[idx];
  if (!item) return;

  if (t.closest('.step')) {
    const b = t.closest('.step');
    const s = item.log.find(x => !x.done);
    if (!s) return;
    const f = b.dataset.f;
    const step = f === 'weight' ? weightStep(item) : 1;
    const cur = parseNum(s[f]) ?? 0;
    s[f] = Math.max(f === 'reps' ? 1 : 0, Math.round((cur + step * Number(b.dataset.d)) * 100) / 100);
    save();
    root.querySelector(`.step-val[data-f="${f}"]`).value = fmtNum(s[f]);
  } else if (t.closest('.set-done')) {
    completeSet(item, idx);
  } else if (t.closest('.done-chip')) {
    item.log[Number(t.closest('.done-chip').dataset.j)].done = false;
    save();
    renderPlan();
  } else if (t.closest('.add-set')) {
    const last = item.log[item.log.length - 1];
    item.log.push({ weight: last ? last.weight : '', reps: last ? last.reps : '', done: false });
    save();
    renderPlan();
  } else if (t.closest('.replace')) {
    replaceExercise(idx);
  } else if (t.closest('.edit-note')) {
    item.noteOpen = true;
    save();
    renderPlan();
    const ta = $('.ex-note');
    if (ta) ta.focus();
  } else if (t.closest('.note-done')) {
    item.noteOpen = false;
    save();
    renderPlan();
  } else if (t.closest('.remove')) {
    removeExercise(idx);
  }
});

// Запоминаем, раскрыт ли блок «Как делать»
root.addEventListener('toggle', e => {
  if (!plan || !e.target.classList || !e.target.classList.contains('tips')) return;
  const item = plan.items[plan.cur];
  if (item) { item.tipsOpen = e.target.open; save(); }
}, true);

function completeSet(item, idx) {
  const s = item.log.find(x => !x.done);
  if (!s) return;
  const weight = parseNum(s.weight);
  const reps = parseInt(s.reps, 10);
  if (!reps || reps <= 0) {
    toast('Укажите, сколько повторов сделали');
    return;
  }
  s.weight = weight ?? 0;
  s.reps = reps;
  s.done = true;
  // Вес и повторы переносим в следующие подходы
  item.log.forEach(x => { if (!x.done) { x.weight = s.weight; x.reps = s.reps; } });

  if (plan.items.every(isDone)) {
    save();
    renderPlan();
    stopTimer();
    toast('Все подходы сделаны! Нажмите «Завершить тренировку» 💪', 5000);
    return;
  }
  startTimer(item.rest);
  if (isDone(item)) {
    const next = nextUnfinished(idx);
    toast(`Готово! Дальше: ${plan.items[next].name}`, 3500);
    plan.cur = next;
    save();
    renderPlan();
    window.scrollTo(0, 0);
  } else {
    save();
    renderPlan();
  }
}

function replaceExercise(idx) {
  const item = plan.items[idx];
  if (item.log.some(x => x.done)) {
    toast('В этом упражнении уже есть подходы — заменить нельзя. Можно убрать его и добавить другое.', 5000);
    return false;
  }
  const alts = item.alternatives || [];
  if (!alts.length) {
    toast('Нет других упражнений на эту группу мышц. Можно добавить любое через «Все упражнения».', 5000);
    return false;
  }
  const [next, ...rest] = alts;
  const old = { ...item };
  delete old.alternatives;
  delete old.log;
  next.alternatives = [...rest, old];
  initLog(next);
  plan.items[idx] = next;
  save();
  renderPlan();
  toast('Заменено на: ' + next.name);
  return true;
}

function removeExercise(idx) {
  const item = plan.items[idx];
  const started = item.log.some(x => x.done);
  if (started && !confirm(`Убрать «${item.name}»? Отмеченные подходы этого упражнения не сохранятся.`)) return false;
  plan.items.splice(idx, 1);
  if (idx < plan.cur || plan.cur >= plan.items.length) plan.cur--;
  if (!plan.items.length) plan.cur = -1;
  save();
  renderPlan();
  toast('Убрано: ' + item.name);
  return true;
}

function moveExercise(idx, dir) {
  const j = idx + dir;
  if (j < 0 || j >= plan.items.length) return;
  [plan.items[idx], plan.items[j]] = [plan.items[j], plan.items[idx]];
  if (plan.cur === idx) plan.cur = j;
  else if (plan.cur === j) plan.cur = idx;
  save();
  renderPlan();
}

// ---------- список всех упражнений: порядок, замена, удаление ----------

function openOverview() {
  let dlg = $('#overview-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'overview-dialog';
    dlg.innerHTML = `<div class="dialog-body">
        <h3>Упражнения плана</h3>
        <p class="small muted" style="margin:4px 0 0">Стрелки меняют порядок. Нажмите на название, чтобы перейти.</p>
        <div class="ov-list"></div>
        <button class="btn ghost wide ov-add" type="button">＋ Добавить упражнение</button>
        <button class="btn ghost wide danger ov-cancel" type="button">Отменить план</button>
        <button class="btn primary wide ov-close" type="button">Закрыть</button>
      </div>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      const i = Number(b.dataset.i);
      if (b.classList.contains('ov-close')) dlg.close();
      else if (b.classList.contains('ov-add')) { dlg.close(); openAddDialog(); }
      else if (b.classList.contains('ov-cancel')) { dlg.close(); cancelPlan(); }
      else if (b.classList.contains('ov-go')) { dlg.close(); go(i); }
      else if (b.classList.contains('ov-up')) { moveExercise(i, -1); fillOverview(dlg); }
      else if (b.classList.contains('ov-down')) { moveExercise(i, 1); fillOverview(dlg); }
      else if (b.classList.contains('ov-rep')) { replaceExercise(i); fillOverview(dlg); }
      else if (b.classList.contains('ov-del')) { removeExercise(i); fillOverview(dlg); }
    });
  }
  fillOverview(dlg);
  dlg.showModal();
}

function fillOverview(dlg) {
  if (!plan) { dlg.close(); return; }
  const n = plan.items.length;
  dlg.querySelector('.ov-list').innerHTML = `
    <div class="ov-row ${plan.cur === -1 ? 'cur' : ''}">
      <button class="ov-go" type="button" data-i="-1">Разминка<small>${plan.warmup_min} мин кардио</small></button>
    </div>
    ${plan.items.map((it, i) => {
      const done = it.log.filter(s => s.done).length;
      return `<div class="ov-row ${i === plan.cur ? 'cur' : ''} ${isDone(it) ? 'finished' : ''}">
        <button class="ov-go" type="button" data-i="${i}">${i + 1}. ${esc(it.name)}
          <small>${done ? `сделано ${done} из ${it.log.length}` : `${it.log.length} × ${it.rep_lo}–${it.rep_hi}`}</small></button>
        <button class="icon-btn ov-up" type="button" data-i="${i}" aria-label="Выше" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="icon-btn ov-down" type="button" data-i="${i}" aria-label="Ниже" ${i === n - 1 ? 'disabled' : ''}>↓</button>
        ${done ? '' : `<button class="icon-btn ov-rep" type="button" data-i="${i}" aria-label="Заменить">⟳</button>`}
        <button class="icon-btn ov-del" type="button" data-i="${i}" aria-label="Убрать">✕</button>
      </div>`;
    }).join('')}`;
}

// ---------- добавить упражнение в план вручную ----------

function openAddDialog() {
  if (!plan.pool) {
    toast('Этот план составлен старой версией. Составьте план заново, чтобы добавлять упражнения.', 5000);
    return;
  }
  let dlg = $('#add-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'add-dialog';
    dlg.innerHTML = `<div class="dialog-body">
        <h3>Добавить упражнение</h3>
        <input class="search" type="search" placeholder="Поиск по названию" aria-label="Поиск">
        <div class="add-list"></div>
        <button class="btn ghost wide close-add" type="button">Закрыть</button>
      </div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('.close-add').addEventListener('click', () => dlg.close());
    dlg.querySelector('.search').addEventListener('input', () => fillAddList(dlg));
    dlg.querySelector('.add-list').addEventListener('click', e => {
      const b = e.target.closest('[data-id]');
      if (!b) return;
      addExercise(Number(b.dataset.id));
      dlg.close();
    });
  }
  dlg.querySelector('.search').value = '';
  fillAddList(dlg);
  dlg.showModal();
}

function fillAddList(dlg) {
  const q = dlg.querySelector('.search').value.trim().toLowerCase();
  const inPlan = new Set(plan.items.map(i => i.exercise_id));
  const list = plan.pool.filter(i => !inPlan.has(i.exercise_id) &&
    (!q || i.name.toLowerCase().includes(q) || i.muscle_label.toLowerCase().includes(q)));
  let html = '';
  let group = null;
  for (const i of list) {
    if (i.muscle_label !== group) {
      group = i.muscle_label;
      html += `<h2>${esc(group)}</h2>`;
    }
    html += `<button class="add-row" type="button" data-id="${i.exercise_id}">
      <span class="thumb">${i.photo ? `<img src="${esc(i.photo)}" alt="" loading="lazy">` : DUMBBELL_SVG}</span>
      <span class="grow">${esc(i.name)}
        <small>${i.off ? '<b class="off-label">выключено вами</b> · ' : ''}${esc(i.equipment || '—')} · ${i.sets} × ${i.rep_lo}–${i.rep_hi}${
          i.risky && i.risky.length ? ' · ⚠ ' + i.risky.map(z => INJURY_LABELS[z]).join(', ') : ''}</small>
      </span>
    </button>`;
  }
  dlg.querySelector('.add-list').innerHTML = html || '<p class="muted">Ничего не найдено</p>';
}

function addExercise(id) {
  const src = plan.pool.find(i => i.exercise_id === id);
  if (!src) return;
  const item = JSON.parse(JSON.stringify(src));
  item.alternatives = [];
  initLog(item);
  plan.items.push(item);
  if (plan.cur >= 0 && isDone(plan.items[plan.cur])) plan.cur = plan.items.length - 1;
  save();
  renderPlan();
  toast(`Добавлено в конец: ${item.name}. Порядок — в «Все упражнения»`, 4000);
}

// ---------- завершение ----------

async function finishWorkout() {
  const sets = [];
  plan.items.forEach(item => item.log.forEach((s, j) => {
    if (s.done) sets.push({ exercise_id: item.exercise_id, set_no: j + 1, weight: s.weight || 0, reps: s.reps });
  }));
  if (!sets.length) {
    if (confirm('Ни один подход не отмечен. Удалить план без сохранения?')) clearPlan();
    return;
  }
  if (!confirm(`Завершить тренировку? Отмечено подходов: ${sets.length}.`)) return;

  const queue = store.get('pending', []);
  queue.push({
    workout_id: plan.workout_id,
    payload: {
      date: plan.date, kind: plan.kind, minutes: plan.minutes, sets,
      notes: plan.notes || {},
    },
  });
  store.set('pending', queue);
  clearPlan(true);
  await flushPending();
  try { me = await api('GET', '/api/me'); store.set('me', me); } catch (e) { /* без связи */ }
  renderSetup(store.get('pending', []).length
    ? 'Тренировка сохранена в телефоне и отправится, когда появится интернет.'
    : 'Тренировка сохранена! Отличная работа 💪');
  window.scrollTo(0, 0);
}

function cancelPlan() {
  const anyDone = plan.items.some(i => i.log.some(s => s.done));
  const msg = anyDone
    ? 'Отменить план? Отмеченные подходы НЕ сохранятся.'
    : 'Отменить этот план и выбрать заново?';
  if (confirm(msg)) clearPlan();
}

function clearPlan(silent) {
  plan = null;
  store.del('plan');
  stopTimer();
  releaseScreen();
  if (!silent) { renderSetup(); window.scrollTo(0, 0); }
}

// ---------- таймер отдыха (кольцо) ----------

let timerEnd = store.get('timer_end');
let timerTotal = store.get('timer_total', 90);
let timerTick = null;
let audioCtx = null;
const RING_C = 2 * Math.PI * 21;

function startTimer(sec) {
  timerEnd = Date.now() + sec * 1000;
  timerTotal = sec;
  store.set('timer_end', timerEnd);
  store.set('timer_total', timerTotal);
  try {   // звук можно включить только после нажатия пользователя
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) { audioCtx = null; }
  runTimer();
}

function runTimer() {
  clearInterval(timerTick);
  const box = $('#timer');
  if (!timerEnd) { box.hidden = true; return; }
  box.hidden = false;
  const update = () => {
    const left = Math.ceil((timerEnd - Date.now()) / 1000);
    if (left <= 0) { timerDone(); return; }
    $('#timer-left').textContent = fmtSec(left);
    const part = Math.min(1, left / timerTotal);
    $('#timer-ring').setAttribute('stroke-dasharray', `${part * RING_C} ${RING_C}`);
  };
  update();
  timerTick = setInterval(update, 250);
}

function timerDone() {
  clearInterval(timerTick);
  timerEnd = null;
  store.del('timer_end');
  $('#timer-left').textContent = 'Пора!';
  $('#timer-ring').setAttribute('stroke-dasharray', `0 ${RING_C}`);
  if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
  beep();
  setTimeout(() => { if (!timerEnd) $('#timer').hidden = true; }, 4000);
}

function stopTimer() {
  clearInterval(timerTick);
  timerEnd = null;
  store.del('timer_end');
  $('#timer').hidden = true;
}

function beep() {
  if (!audioCtx) return;
  try {
    [0, 0.35].forEach(delay => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.2;
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(audioCtx.currentTime + delay);
      osc.stop(audioCtx.currentTime + delay + 0.2);
    });
  } catch (e) { /* без звука */ }
}

$('#t-plus').addEventListener('click', () => {
  if (timerEnd) {
    timerEnd += 30000;
    timerTotal += 30;
    store.set('timer_end', timerEnd);
    store.set('timer_total', timerTotal);
  } else {
    startTimer(30);
  }
});
$('#t-skip').addEventListener('click', stopTimer);

// Если вернулись в приложение — пересчитать таймер
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (timerEnd) runTimer();
    if (plan) keepScreenOn();
  }
});

// ---------- не гасить экран во время тренировки ----------

let wakeLock = null;
async function keepScreenOn() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { /* не поддерживается — не страшно */ }
}
function releaseScreen() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

// ---------- запуск ----------

renderNav('workout');
$('#today').textContent = new Date().toLocaleDateString('ru-RU',
  { weekday: 'long', day: 'numeric', month: 'long' });
if (timerEnd && timerEnd < Date.now()) { timerEnd = null; store.del('timer_end'); }

(async () => {
  try {
    me = await requireAuth();
  } catch (e) {
    if (!plan) return;   // без интернета, но план есть — покажем его
  }
  flushPending();
  if (plan) renderPlan(); else renderSetup();
  runTimer();
})();
