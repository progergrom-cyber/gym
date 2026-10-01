'use strict';
// Страница «Тренировка»: составление плана, отметка подходов, таймер отдыха.

const MINUTES = [30, 45, 60, 90];
const KINDS = { upper: 'Верх', lower: 'Низ', full: 'Фулбади' };

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
    <div class="card">
      <div class="small muted">Цель и режим</div>
      <div>${esc(GOAL_LABELS[p.goal] || '—')} · ${p.freq || 3} раза в неделю</div>
      ${injuries ? `<div class="small" style="color:var(--warn)">Ограничения: ${esc(injuries)}</div>` : ''}
      <a class="small" href="/settings">Изменить</a>
    </div>

    <h2>Сколько есть времени?</h2>
    <div class="seg" id="minutes">
      ${MINUTES.map(m => `<button type="button" data-v="${m}"
        class="${m === choice.minutes ? 'on' : ''}">${m} мин</button>`).join('')}
    </div>

    <h2>Что тренируем?</h2>
    <div class="seg" id="kind">
      ${Object.entries(KINDS).map(([k, label]) => `<button type="button" data-v="${k}"
        class="${k === choice.kind ? 'on' : ''}">${label}</button>`).join('')}
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
  return `
  <article class="card ex ${done === item.log.length ? 'complete' : ''}" data-i="${idx}">
    <div class="ex-top">
      <span class="num">${done === item.log.length ? '✓' : idx + 1}</span>
      <div>
        <h3>${esc(item.name)}</h3>
        <div class="small muted">${esc(item.equipment)} · ${esc(item.muscle_label)} ·
          ${item.kind === 'compound' ? 'база' : 'изоляция'}</div>
      </div>
    </div>
    <div class="presc">${item.sets} × ${item.rep_lo}–${item.rep_hi} повт. · отдых ${fmtSec(item.rest)}</div>
    <div class="hint">💡 ${esc(item.hint)}</div>
    <div class="sets">
      <div class="set-head"><span>№</span><span>Вес, кг</span><span>Повторы</span><span></span></div>
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
      ${started ? '' : '<button class="btn small ghost replace" type="button">🔄 Заменить</button>'}
    </div>
  </article>`;
}

function renderPlan() {
  const warnings = plan.warnings || [];
  root.innerHTML = `
    <div class="plan-head">
      <div>
        <div class="h">${esc(plan.kind_label)} · ≈${planMinutes()} мин</div>
        <div class="small muted">${esc(fmtDate(plan.date))} · вы выбрали ${plan.minutes} мин</div>
      </div>
    </div>
    ${warnings.length ? `<details class="note warn"><summary>Подсказки (${warnings.length})</summary>
      <ul>${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
    <div class="card">
      <b>Разминка ~${plan.warmup_min} мин</b>
      <div class="small muted">5 минут лёгкого кардио (велотренажёр, эллипс) и вращения в плечах,
        локтях, коленях. В базовых упражнениях первый подход можно сделать с половиной веса.</div>
    </div>
    ${plan.items.map(renderItem).join('')}
    ${plan.items.length ? '' : '<div class="note warn">В плане нет упражнений.</div>'}
    <button class="btn primary big" id="finish" type="button">Завершить тренировку</button>
    <button class="btn ghost wide" id="cancel" type="button">Отменить план</button>`;
  $('#finish').addEventListener('click', finishWorkout);
  $('#cancel').addEventListener('click', cancelPlan);
  keepScreenOn();
}

// Ввод веса и повторов — сохраняем сразу, чтобы ничего не потерялось
root.addEventListener('input', e => {
  if (!plan) return;
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
  const card = e.target.closest('.ex');
  if (!card) return;
  const idx = Number(card.dataset.i);
  const item = plan.items[idx];

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
  }
});

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
  // Подставим этот вес в следующий подход
  const next = item.log[j + 1];
  if (next && !next.done) next.weight = s.weight;
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
    payload: { date: plan.date, kind: plan.kind, minutes: plan.minutes, sets },
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

function startTimer(sec) {
  timerEnd = Date.now() + sec * 1000;
  store.set('timer_end', timerEnd);
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
  if (timerEnd) { timerEnd += 30000; store.set('timer_end', timerEnd); }
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
