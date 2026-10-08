'use strict';
// Страница «Тренировка»: составление плана, отметка подходов, таймер отдыха.

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

// ---------- экран выбора ----------

function renderSetup(message) {
  const choice = store.get('choice', { minutes: 60, kind: 'full' });
  const p = (me && me.profile) || {};
  const injuries = (p.injuries || []).map(i => INJURY_LABELS[i]).join(', ');
  const needProfile = me && (!p.height || !me.has_weight);

  root.innerHTML = `
    ${message ? `<div class="note ok">${esc(message)}</div>` : ''}
    ${needProfile ? `<div class="note warn">Заполните рост в разделе
      <a href="/settings">Профиль</a> и вес в разделе <a href="/progress#body">Прогресс</a>.</div>` : ''}
    <div class="card profile-line">
      <div class="grow">
        <div style="font-weight:700">${esc(GOAL_LABELS[p.goal] || '—')}</div>
        <span class="chip">${p.freq || 3} раза в неделю</span>
        ${injuries ? `<span class="chip warn">⚠ ${esc(injuries)}</span>` : ''}
      </div>
      <a class="btn small ghost" href="/settings">Изменить</a>
    </div>

    <h2>Сколько есть времени</h2>
    <div class="tiles" id="minutes">
      ${MINUTES.map(m => `<button type="button" data-v="${m}"
        class="tile ${m === choice.minutes ? 'on' : ''}"><b>${m}</b><small>минут</small></button>`).join('')}
    </div>

    <h2>Что тренируем</h2>
    <div class="tiles two" id="kind">
      ${Object.entries(KINDS).map(([k, label]) => `<button type="button" data-v="${k}"
        class="tile ${k === choice.kind ? 'on' : ''}"><b>${label}</b><small>${KIND_HINTS[k]}</small></button>`).join('')}
    </div>

    <button class="btn primary big" id="make" type="button">Составить план</button>
    <p class="muted small center">Для составления плана нужен интернет.
      Готовый план откроется и в зале без связи.</p>`;

  for (const id of ['minutes', 'kind']) {
    $('#' + id).addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      $('#' + id).querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
      const c = store.get('choice', { minutes: 60, kind: 'full' });
      c[id] = id === 'minutes' ? Number(btn.dataset.v) : btn.dataset.v;
      store.set('choice', c);
    });
  }
  $('#make').addEventListener('click', makePlan);
}

async function makePlan() {
  const btn = $('#make');
  const choice = store.get('choice', { minutes: 60, kind: 'full' });
  btn.disabled = true;
  btn.textContent = 'Составляю…';
  try {
    await flushPending();  // сначала отправим прошлую тренировку, если она ждёт
    const res = await api('POST', '/api/plan',
      { minutes: choice.minutes, kind: choice.kind, date: todayISO() });
    plan = res.plan;
    plan.items.forEach(initLog);
    save();
    renderPlan();
    window.scrollTo(0, 0);
  } catch (e) {
    toast(e.message, 4000);
    btn.disabled = false;
    btn.textContent = 'Составить план';
  }
}

// ---------- экран плана ----------

function planMinutes() {
  const sec = plan.warmup_min * 60 + plan.items.reduce((s, i) => s + i.seconds, 0);
  return Math.round(sec / 60);
}

function renderItem(item, idx) {
  const done = item.log.filter(s => s.done).length;
  const started = done > 0;
  const complete = done === item.log.length;
  return `
  <article class="card ex ${complete ? 'complete' : ''}" data-i="${idx}">
    ${item.photo ? `<button class="ex-photo" type="button" data-photo="${esc(item.photo)}"
      aria-label="Открыть фото тренажёра"><img src="${esc(item.photo)}" alt="" loading="lazy"></button>` : ''}
    <div class="ex-body">
      <div class="ex-top">
        <span class="num">${complete ? '✓' : idx + 1}</span>
        <div>
          <h3>${esc(item.name)}</h3>
          <div class="meta">${esc(item.equipment)}${item.equipment ? ' · ' : ''}${esc(item.muscle_label)}</div>
        </div>
      </div>
      <div class="presc">
        <span>${item.sets} × ${item.rep_lo}–${item.rep_hi}</span>
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
      <div class="sets">
        <div class="set-head"><span>#</span><span>Вес, кг</span><span>Повторы</span><span></span></div>
        ${item.log.map((s, j) => `
          <div class="set ${s.done ? 'done' : ''}" data-j="${j}">
            <span class="set-no">${j + 1}</span>
            <input class="w" inputmode="decimal" autocomplete="off" aria-label="Вес, подход ${j + 1}"
              value="${esc(typeof s.weight === 'number' ? fmtNum(s.weight) : s.weight)}" placeholder="кг" ${s.done ? 'readonly' : ''}>
            <input class="r" inputmode="numeric" autocomplete="off" aria-label="Повторы, подход ${j + 1}"
              value="${esc(s.reps)}" placeholder="${item.rep_lo}–${item.rep_hi}" ${s.done ? 'readonly' : ''}>
            <button class="check" type="button" aria-label="Подход выполнен">${s.done ? '✓' : ''}</button>
          </div>`).join('')}
      </div>
      <div class="ex-actions">
        <button class="btn small ghost add-set" type="button">+ подход</button>
        ${started ? '' : '<button class="btn small ghost replace" type="button">Заменить</button>'}
        ${item.noteOpen || noteOf(item) ? '' : '<button class="btn small ghost edit-note" type="button">📝 Заметка</button>'}
        <button class="btn small ghost danger remove" type="button">Убрать</button>
      </div>
    </div>
  </article>`;
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

function renderWarmup() {
  const options = plan.warmup || [];
  const w = options[plan.warmup_idx || 0];
  return `
    <div class="card warmup">
      ${w && w.photo ? `<button class="thumb big ex-photo" type="button" data-photo="${esc(w.photo)}"
        aria-label="Открыть фото"><img src="${esc(w.photo)}" alt="" loading="lazy"></button>` : ''}
      <div class="grow">
        <h3>Разминка ~${plan.warmup_min} мин</h3>
        <div class="small muted" style="margin-top:4px">${w
          ? `5 минут: <b style="color:var(--text)">${esc(w.name)}</b>${w.equipment ? ' (' + esc(w.equipment) + ')' : ''}, в лёгком темпе.`
          : '5 минут лёгкого кардио (дорожка, велотренажёр, эллипс).'}
          Потом вращения в плечах, локтях, коленях. В базовых упражнениях первый подход
          можно сделать с половиной веса.</div>
        ${options.length > 1 ? '<button class="btn small ghost" type="button" id="warmup-next" style="margin-top:10px">Другой тренажёр</button>' : ''}
      </div>
    </div>`;
}

function renderPlan() {
  const warnings = plan.warnings || [];
  const total = plan.items.reduce((n, i) => n + i.log.length, 0);
  const done = plan.items.reduce((n, i) => n + i.log.filter(s => s.done).length, 0);
  const pct = total ? Math.round(done / total * 100) : 0;
  root.innerHTML = `
    <div class="hero">
      <div class="h">${esc(plan.kind_label)} · ${planMinutes()} мин</div>
      <div class="small muted">${esc(fmtDate(plan.date))} · ${plan.items.length} упражнений · лимит ${plan.minutes} мин</div>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <div class="hero-stats"><span>Сделано подходов: ${done} из ${total}</span><span>${pct}%</span></div>
    </div>
    ${warnings.length ? `<details class="note warn"><summary>Подсказки (${warnings.length})</summary>
      <ul>${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
    ${renderWarmup()}
    ${plan.items.map(renderItem).join('')}
    ${plan.items.length ? '' : '<div class="note warn">В плане нет упражнений.</div>'}
    <button class="btn ghost wide" id="add-ex" type="button">＋ Добавить упражнение</button>
    <button class="btn primary big" id="finish" type="button">Завершить тренировку</button>
    <button class="btn ghost wide" id="cancel" type="button">Отменить план</button>`;
  $('#finish').addEventListener('click', finishWorkout);
  const wn = $('#warmup-next');
  if (wn) wn.addEventListener('click', () => {
    plan.warmup_idx = ((plan.warmup_idx || 0) + 1) % plan.warmup.length;
    save();
    renderPlan();
  });
  $('#cancel').addEventListener('click', cancelPlan);
  $('#add-ex').addEventListener('click', openAddDialog);
  keepScreenOn();
}

// Ввод веса и повторов — сохраняем сразу, чтобы ничего не потерялось
root.addEventListener('input', e => {
  if (!plan) return;
  if (e.target.classList.contains('ex-note')) {
    const item = plan.items[e.target.closest('.ex').dataset.i];
    plan.notes = plan.notes || {};
    plan.notes[item.exercise_id] = e.target.value;
    save();
    return;
  }
  const card = e.target.closest('.ex');
  const row = e.target.closest('.set');
  if (!card || !row) return;
  const s = plan.items[card.dataset.i].log[row.dataset.j];
  if (e.target.classList.contains('w')) s.weight = e.target.value;
  if (e.target.classList.contains('r')) s.reps = e.target.value;
  save();
});

root.addEventListener('click', e => {
  if (!plan) return;
  const warmPhoto = e.target.closest('.warmup .ex-photo');
  if (warmPhoto) { showPhoto(warmPhoto.dataset.photo); return; }
  const card = e.target.closest('.ex');
  if (!card) return;
  const idx = Number(card.dataset.i);
  const item = plan.items[idx];

  if (e.target.closest('.ex-photo')) {
    showPhoto(e.target.closest('.ex-photo').dataset.photo);
    return;
  }
  if (e.target.closest('.check')) {
    const row = e.target.closest('.set');
    toggleSet(item, Number(row.dataset.j), row);
  } else if (e.target.closest('.add-set')) {
    const last = item.log[item.log.length - 1];
    item.log.push({ weight: last ? last.weight : '', reps: '', done: false });
    save();
    renderPlan();
  } else if (e.target.closest('.replace')) {
    replaceExercise(idx);
  } else if (e.target.closest('.edit-note')) {
    item.noteOpen = true;
    save();
    renderPlan();
    const ta = $(`.ex[data-i="${idx}"] .ex-note`);
    if (ta) ta.focus();
  } else if (e.target.closest('.note-done')) {
    item.noteOpen = false;
    save();
    renderPlan();
  } else if (e.target.closest('.remove')) {
    removeExercise(idx);
  }
});

// Запоминаем, раскрыт ли блок «Как делать» (чтобы не закрывался при отметке подхода)
root.addEventListener('toggle', e => {
  if (!plan || !e.target.classList || !e.target.classList.contains('tips')) return;
  const item = plan.items[e.target.closest('.ex').dataset.i];
  item.tipsOpen = e.target.open;
  save();
}, true);

function removeExercise(idx) {
  const item = plan.items[idx];
  const started = item.log.some(x => x.done);
  if (started && !confirm(`Убрать «${item.name}»? Отмеченные подходы этого упражнения не сохранятся.`)) return;
  plan.items.splice(idx, 1);
  save();
  renderPlan();
  toast('Убрано: ' + item.name);
}

// ---------- добавить упражнение в план вручную ----------

function openAddDialog() {
  const pool = plan.pool;
  if (!pool) {
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
        <small>${esc(i.equipment || '—')} · ${i.sets} × ${i.rep_lo}–${i.rep_hi}${
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
  save();
  renderPlan();
  const cards = document.querySelectorAll('.ex');
  cards[cards.length - 1].scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast('Добавлено: ' + item.name);
}

function toggleSet(item, j, row) {
  const s = item.log[j];
  if (s.done) {             // повторное нажатие — снять отметку и исправить
    s.done = false;
    save();
    renderPlan();
    return;
  }
  const weight = parseNum(row.querySelector('.w').value);
  const reps = parseInt(row.querySelector('.r').value, 10);
  if (!reps || reps <= 0) {
    toast('Введите, сколько повторов сделали');
    row.querySelector('.r').focus();
    return;
  }
  s.weight = weight ?? 0;
  s.reps = reps;
  s.done = true;
  // Подставим этот вес во все следующие подходы
  item.log.slice(j + 1).forEach(next => { if (!next.done) next.weight = s.weight; });
  save();
  renderPlan();
  const allDone = plan.items.every(i => i.log.every(x => x.done));
  if (allDone) {
    stopTimer();
    toast('Все подходы сделаны! Нажмите «Завершить тренировку» 💪', 5000);
  } else {
    startTimer(item.rest);
  }
}

function replaceExercise(idx) {
  const item = plan.items[idx];
  const alts = item.alternatives || [];
  if (!alts.length) {
    toast('Нет других упражнений на эту группу мышц. Добавьте их в разделе «Профиль → Тренажёры».', 5000);
    return;
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
}

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

// ---------- таймер отдыха ----------

let timerEnd = store.get('timer_end');
let timerTick = null;
let audioCtx = null;

let timerTotal = store.get('timer_total', 90);

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
    $('#timer-bar').style.width = Math.min(100, left / timerTotal * 100) + '%';
  };
  update();
  timerTick = setInterval(update, 250);
}

function timerDone() {
  clearInterval(timerTick);
  timerEnd = null;
  store.del('timer_end');
  $('#timer-left').textContent = 'Пора! 💪';
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
  }
  else startTimer(30);
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
