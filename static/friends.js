'use strict';
// Страница «Компания»: лента друзей, рейтинг месяца, достижения и рекорды.

let data = null;

function showTab(tab) {
  document.querySelectorAll('#tabs button').forEach(b =>
    b.classList.toggle('on', b.dataset.tab === tab));
  ['feed', 'board', 'awards'].forEach(t => { $('#' + t).hidden = t !== tab; });
  history.replaceState(null, '', tab === 'feed' ? location.pathname : '#' + tab);
}
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) showTab(b.dataset.tab);
});

function fmtKg(v) {
  if (v >= 10000) return fmtNum(Math.round(v / 100) / 10) + ' т';
  return Math.round(v).toLocaleString('ru-RU') + ' кг';
}

function initials(name) {
  return esc(name.slice(0, 1).toUpperCase());
}

// ---------- согласие ----------

function renderConsent() {
  $('#share-toggle').checked = data.share === true;
  if (data.share !== null) { $('#consent').innerHTML = ''; return; }
  $('#consent').innerHTML = `
    <div class="card consent">
      <h3>Показывать ваши тренировки друзьям?</h3>
      <p class="small muted">Друзья увидят дату, тип тренировки, тоннаж и ваши рекорды.
        Вес тела, замеры и заметки не видны никому. Это можно поменять в любой момент
        переключателем внизу страницы.</p>
      <div class="dialog-actions">
        <button class="btn ghost" type="button" data-share="0">Нет</button>
        <button class="btn primary" type="button" data-share="1">Да</button>
      </div>
    </div>`;
}

async function setShare(share) {
  try {
    await api('PUT', '/api/friends/share', { share });
    toast(share ? 'Друзья видят ваши тренировки' : 'Ваши тренировки скрыты от друзей');
    load();
  } catch (e) {
    toast(e.message);
    $('#share-toggle').checked = data.share === true;
  }
}

$('#consent').addEventListener('click', e => {
  const b = e.target.closest('[data-share]');
  if (b) setShare(b.dataset.share === '1');
});
$('#share-toggle').addEventListener('change', e => setShare(e.target.checked));

// ---------- лента ----------

function renderFeed() {
  const hidden = data.share !== true
    ? '<div class="note warn">Ваши тренировки сейчас не видны друзьям.</div>' : '';
  if (!data.feed.length) {
    $('#feed').innerHTML = hidden + `<p class="muted">Пока пусто. Лента появится, когда друзья
      начнут тренироваться и включат показ своих результатов.</p>`;
    return;
  }
  $('#feed').innerHTML = hidden + data.feed.map(w => `
    <article class="card feed-item">
      <div class="feed-head">
        <span class="avatar ${w.me ? 'me' : ''}">${initials(w.username)}</span>
        <div class="grow">
          <b>${esc(w.username)}${w.me ? ' (вы)' : ''}</b>
          <div class="small muted">${esc(fmtDate(w.date))}</div>
        </div>
        <span class="chip">${esc(w.kind_label)}</span>
      </div>
      <div class="feed-stats">
        <span><b>${w.exercises}</b> упр.</span>
        <span><b>${w.sets}</b> подходов</span>
        <span><b>${fmtKg(w.volume)}</b> тоннаж</span>
      </div>
      ${w.records.map(r => `<div class="record">⭐ Рекорд: ${esc(r.name)} —
        <b>${fmtNum(r.weight)} кг</b> <span class="muted">(было ${fmtNum(r.prev)})</span></div>`).join('')}
    </article>`).join('');
}

// ---------- рейтинг ----------

function renderBoard() {
  const [y, m] = data.month.split('-').map(Number);
  const title = new Date(y, m - 1, 1).toLocaleDateString('ru-RU', { month: 'long' });
  $('#board-title').textContent = 'Рейтинг: ' + title;
  if (!data.board.length) {
    $('#board-list').innerHTML = '<p class="muted">Пока никто не включил показ результатов.</p>';
    return;
  }
  $('#board-list').innerHTML = `<div class="board">${data.board.map((b, i) => `
    <div class="board-row ${b.me ? 'me' : ''}">
      <span class="place">${i < 3 && b.visits ? ['🥇', '🥈', '🥉'][i] : i + 1}</span>
      <span class="grow"><b>${esc(b.username)}</b>${b.me ? ' (вы)' : ''}
        <small>${b.workouts} трен. · ${fmtKg(b.volume)}</small></span>
      <span class="visits"><b>${b.visits}</b><small>посещ.</small></span>
    </div>`).join('')}</div>`;
}

// ---------- достижения ----------

function renderAwards() {
  $('#ach').innerHTML = data.achievements.map(a => `
    <div class="ach ${a.done ? 'done' : ''}">
      <span class="ach-icon">${a.icon}</span>
      <b>${esc(a.title)}</b>
      <small>${esc(a.desc)}</small>
      ${a.done ? '<small class="ach-ok">Получено ✓</small>' : `
        <span class="mini-progress"><i style="width:${a.value / a.need * 100}%"></i></span>
        <small>${a.need >= 1000 ? fmtKg(a.value) + ' из ' + fmtKg(a.need) : a.value + ' из ' + a.need}</small>`}
    </div>`).join('');
  $('#records').innerHTML = data.records.length ? data.records.map(r => `
    <div class="row">
      <div class="grow">${esc(r.name)}<div class="small muted">${esc(fmtDate(r.date, false))}</div></div>
      <b>${fmtNum(r.weight)} кг</b>
    </div>`).join('') : '<p class="muted">Рекорды появятся после первых тренировок.</p>';
}

// ---------- запуск ----------

async function load() {
  try {
    data = await api('GET', '/api/friends');
    renderConsent();
    renderFeed();
    renderBoard();
    renderAwards();
  } catch (e) {
    $('#feed').innerHTML = `<div class="note warn">${esc(e.message)}</div>`;
  }
}

renderNav('friends');
(async () => {
  try { await requireAuth(); } catch (e) { return; }
  const tab = location.hash.slice(1);
  showTab(['feed', 'board', 'awards'].includes(tab) ? tab : 'feed');
  load();
})();
