'use strict';
// Админ-панель: люди, инвайт-коды, журнал каталога, система и резервные копии.

let data = null;
let codeCount = 1;
const TABS = ['people', 'codes', 'log', 'system'];

function showTab(tab) {
  document.querySelectorAll('#tabs button').forEach(b =>
    b.classList.toggle('on', b.dataset.tab === tab));
  TABS.forEach(t => { $('#' + t).hidden = t !== tab; });
  history.replaceState(null, '', tab === 'people' ? location.pathname : '#' + tab);
  if (tab === 'log') loadLog();
}
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) showTab(b.dataset.tab);
});

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return fmtNum(Math.round(bytes / 1024 / 102.4) / 10) + ' МБ';
  return Math.max(1, Math.round(bytes / 1024)) + ' КБ';
}

function fmtWhen(sqlTime) {
  // время в базе — UTC, показываем по времени телефона
  if (!sqlTime) return '';
  const d = new Date(sqlTime.replace(' ', 'T') + 'Z');
  return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// ---------- люди ----------

function renderUsers() {
  $('#users').innerHTML = data.users.map(u => {
    const me = u.id === data.me;
    return `
    <article class="card admin-user ${u.blocked ? 'blocked' : ''}" data-id="${u.id}">
      <div class="feed-head">
        <span class="avatar ${me ? 'me' : ''}">${esc(u.username.slice(0, 1).toUpperCase())}</span>
        <div class="grow">
          <b>${esc(u.username)}</b>${me ? ' (вы)' : ''}
          ${u.is_admin ? '<span class="chip">админ</span>' : ''}
          ${u.blocked ? '<span class="chip warn">заблокирован</span>' : ''}
          <div class="small muted">с ${esc(fmtDate(u.created_at.slice(0, 10), false))}
            · тренировок: ${u.workouts}${u.last_date ? ` · последняя ${esc(fmtDate(u.last_date, false))}` : ''}
            ${u.invite ? ` · код ${esc(u.invite)}` : ''}</div>
        </div>
      </div>
      ${me ? '' : `<div class="ex-actions">
        <button class="btn small ghost act-pw" type="button">🔑 Сбросить пароль</button>
        <button class="btn small ghost act-block" type="button">${u.blocked ? 'Разблокировать' : 'Заблокировать'}</button>
        <button class="btn small ghost act-admin" type="button">${u.is_admin ? 'Убрать админа' : 'Сделать админом'}</button>
        <button class="btn small ghost danger act-del" type="button">Удалить</button>
      </div>`}
    </article>`;
  }).join('');
}

$('#users').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  const id = Number(b.closest('[data-id]').dataset.id);
  const u = data.users.find(x => x.id === id);
  try {
    if (b.classList.contains('act-pw')) {
      if (!confirm(`Сбросить пароль для «${u.username}»? Старый пароль перестанет работать.`)) return;
      const res = await api('POST', `/api/admin/users/${id}/password`, {});
      $('#pw-value').textContent = res.password;
      $('#pw-dialog').showModal();
    } else if (b.classList.contains('act-block')) {
      const block = !u.blocked;
      if (block && !confirm(`Заблокировать «${u.username}»? Он не сможет войти, данные сохранятся.`)) return;
      await api('POST', `/api/admin/users/${id}/block`, { blocked: block });
      toast(block ? 'Заблокирован' : 'Разблокирован');
      load();
    } else if (b.classList.contains('act-admin')) {
      const make = !u.is_admin;
      if (make && !confirm(`Дать «${u.username}» права администратора? Он сможет управлять людьми и кодами.`)) return;
      await api('POST', `/api/admin/users/${id}/admin`, { admin: make });
      toast(make ? 'Теперь администратор' : 'Права администратора убраны');
      load();
    } else if (b.classList.contains('act-del')) {
      const typed = prompt(`Удалить «${u.username}» и ВСЕ его тренировки, замеры и заметки? ` +
        'Это нельзя отменить.\n\nДля подтверждения введите логин:');
      if (typed === null) return;
      await api('POST', `/api/admin/users/${id}/delete`, { confirm: typed });
      toast('Пользователь удалён');
      load();
    }
  } catch (err) {
    toast(err.message, 4000);
  }
});

$('#pw-close').addEventListener('click', () => $('#pw-dialog').close());
$('#pw-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#pw-value').textContent);
    toast('Скопировано');
  } catch (e) {
    toast('Не получилось скопировать — перепишите вручную');
  }
});

// ---------- инвайт-коды ----------

function renderInvites() {
  $('#invites').innerHTML = data.invites.length ? data.invites.map(i => `
    <div class="row" data-code="${esc(i.code)}">
      <div class="grow">
        <b class="mono">${esc(i.code)}</b>
        <div class="small muted">${i.username
          ? `использован: ${esc(i.username)}${i.used_at ? ', ' + esc(fmtWhen(i.used_at)) : ''}`
          : `свободен · создан ${esc(fmtWhen(i.created_at))}`}</div>
      </div>
      ${i.username ? '' : `<button class="icon-btn copy-code" type="button" aria-label="Скопировать код">⧉</button>
        <button class="icon-btn del-code" type="button" aria-label="Удалить код">✕</button>`}
    </div>`).join('') : '<p class="muted">Кодов пока нет.</p>';
}

$('#code-count').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  codeCount = Number(b.dataset.n);
  $('#code-count').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
});

$('#make-codes').addEventListener('click', async () => {
  try {
    const { codes } = await api('POST', '/api/admin/invites', { count: codeCount });
    $('#new-codes').innerHTML = `<div class="note ok">Новые коды:<div class="secret">${codes.map(esc).join('<br>')}</div>
      <div class="small">Ссылка на сайт: ${esc(location.origin)}</div></div>`;
    load();
  } catch (e) {
    toast(e.message);
  }
});

$('#invites').addEventListener('click', async e => {
  const row = e.target.closest('[data-code]');
  if (!row) return;
  const code = row.dataset.code;
  if (e.target.closest('.copy-code')) {
    try {
      await navigator.clipboard.writeText(`Код для «Тренера»: ${code}\n${location.origin}`);
      toast('Код и ссылка скопированы');
    } catch (err) { toast('Не получилось скопировать'); }
  } else if (e.target.closest('.del-code')) {
    if (!confirm(`Удалить код ${code}? Им больше нельзя будет зарегистрироваться.`)) return;
    try {
      await api('DELETE', `/api/admin/invites/${encodeURIComponent(code)}`);
      load();
    } catch (err) { toast(err.message); }
  }
});

// ---------- журнал ----------

async function loadLog() {
  try {
    const { items } = await api('GET', '/api/admin/log');
    $('#log-list').innerHTML = items.length ? items.map(r => `
      <div class="row">
        <div class="grow">
          <b>${esc(r.username)}</b> · ${esc(r.exercise_name)}
          <div class="small">${esc(r.action)}</div>
          <div class="small muted">${esc(fmtWhen(r.created_at))}</div>
        </div>
      </div>`).join('') : '<p class="muted">Изменений пока не было.</p>';
  } catch (e) {
    $('#log-list').innerHTML = `<div class="note warn">${esc(e.message)}</div>`;
  }
}

// ---------- система ----------

function renderSystem() {
  const s = data.system;
  const tile = (v, l) => `<div class="stat"><div class="stat-v">${v}</div><div class="stat-l">${l}</div></div>`;
  $('#sys-stats').innerHTML =
    tile(s.users, 'пользователей') +
    tile(s.workouts, 'тренировок всего') +
    tile(s.workouts_week, 'тренировок за 7 дней') +
    tile(s.sets, 'подходов записано') +
    tile(fmtSize(s.db_size), 'размер базы') +
    tile(s.photos ? `${s.photos} · ${fmtSize(s.photos_size)}` : 'нет', 'фото тренажёров');
}

// ---------- запуск ----------

async function load() {
  try {
    data = await api('GET', '/api/admin/overview');
    renderUsers();
    renderInvites();
    renderSystem();
  } catch (e) {
    if (e.status === 403) {
      $('#panel').hidden = true;
      $('#denied').hidden = false;
    } else {
      toast(e.message, 4000);
    }
  }
}

renderNav('settings');
(async () => {
  let me;
  try { me = await requireAuth(); } catch (e) { return; }
  if (!me.profile.is_admin) { $('#denied').hidden = false; return; }
  $('#panel').hidden = false;
  const tab = location.hash.slice(1);
  showTab(TABS.includes(tab) ? tab : 'people');
  load();
})();
