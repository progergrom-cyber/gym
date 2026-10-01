'use strict';
// Страница «Профиль»: мои настройки и общий каталог тренажёров.

let catalog = { items: [], missing: [], muscles: {}, injuries: INJURY_LABELS };
let editingId = null;

function injuryBoxes(name) {
  return Object.entries(INJURY_LABELS).map(([k, label]) =>
    `<label class="choice"><input type="checkbox" name="${name}" value="${k}"> ${label}</label>`
  ).join('');
}

// ---------- вкладки ----------

function showTab(tab) {
  document.querySelectorAll('#tabs button').forEach(b =>
    b.classList.toggle('on', b.dataset.tab === tab));
  $('#profile').hidden = tab !== 'profile';
  $('#catalog').hidden = tab !== 'catalog';
  history.replaceState(null, '', tab === 'catalog' ? '#catalog' : location.pathname);
}
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) showTab(b.dataset.tab);
});

// ---------- профиль ----------

$('#injuries').innerHTML = injuryBoxes('injury');

$('#freq').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  $('#freq').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
});

function fillProfile(p) {
  const f = $('#p-form');
  f.height.value = p.height ? fmtNum(p.height) : '';
  f.querySelectorAll('[name=goal]').forEach(r => { r.checked = r.value === p.goal; });
  $('#freq').querySelectorAll('button').forEach(b =>
    b.classList.toggle('on', Number(b.dataset.v) === p.freq));
  f.querySelectorAll('[name=injury]').forEach(c => { c.checked = p.injuries.includes(c.value); });
  $('#username').textContent = p.username;
}

$('#p-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const freqBtn = $('#freq .on');
  const goal = f.querySelector('[name=goal]:checked');
  const data = {
    height: f.height.value,
    goal: goal ? goal.value : null,
    freq: freqBtn ? Number(freqBtn.dataset.v) : null,
    injuries: [...f.querySelectorAll('[name=injury]:checked')].map(c => c.value),
  };
  $('#p-error').textContent = '';
  try {
    await api('PUT', '/api/profile', data);
    const me = await api('GET', '/api/me');
    store.set('me', me);
    toast('Сохранено ✓');
  } catch (err) {
    $('#p-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', logout);

// ---------- каталог ----------

async function loadCatalog() {
  try {
    catalog = await api('GET', '/api/exercises');
    renderCatalog();
  } catch (e) {
    $('#ex-list').innerHTML = `<div class="note warn">${esc(e.message)}</div>`;
  }
}

function renderCatalog() {
  const { items, missing, muscles } = catalog;

  if (missing.length) {
    $('#missing').innerHTML = `
      <details class="note warn"><summary>Не хватает упражнений: ${missing.length}
        ${missing.length === 1 ? 'группа' : missing.length < 5 ? 'группы' : 'групп'} мышц</summary>
        <ul>${missing.map(m => {
          const off = items.find(e => e.muscle === m.muscle && !e.active);
          return `<li><b>${esc(m.label)}</b>: ${off
            ? `включите «${esc(off.name)}», если такой тренажёр есть`
            : `например, ${esc(m.hint)}`}</li>`;
        }).join('')}</ul></details>`;
  } else {
    $('#missing').innerHTML = '';
  }

  const groups = Object.keys(muscles).map(m => ({
    key: m, label: muscles[m], list: items.filter(e => e.muscle === m),
  })).filter(g => g.list.length);

  $('#ex-list').innerHTML = groups.map(g => `
    <h2>${esc(g.label)}</h2>
    <div class="card" style="margin-top:0">
      ${g.list.map(e => `
        <div class="row ${e.active ? '' : 'off'}" data-id="${e.id}">
          <button class="row-btn grow" type="button">
            ${esc(e.name)}
            <small>${esc(e.equipment || '—')} · ${e.kind === 'compound' ? 'база' : 'изоляция'}${
              e.stress.length ? ' · ⚠️ ' + e.stress.map(s => INJURY_LABELS[s]).join(', ') : ''}</small>
          </button>
          <label class="switch" aria-label="Включено">
            <input type="checkbox" class="toggle" ${e.active ? 'checked' : ''}><span></span>
          </label>
        </div>`).join('')}
    </div>`).join('');
}

$('#ex-list').addEventListener('click', e => {
  if (e.target.closest('.row-btn')) {
    openEditor(Number(e.target.closest('[data-id]').dataset.id));
  }
});

$('#ex-list').addEventListener('change', async e => {
  if (!e.target.classList.contains('toggle')) return;
  const id = Number(e.target.closest('[data-id]').dataset.id);
  const ex = catalog.items.find(x => x.id === id);
  try {
    await api('PUT', `/api/exercises/${id}`, { ...ex, active: e.target.checked });
    toast(e.target.checked ? 'Упражнение включено' : 'Упражнение выключено');
    loadCatalog();
  } catch (err) {
    e.target.checked = !e.target.checked;
    toast(err.message);
  }
});

// ---------- окно редактирования ----------

const dialog = $('#ex-dialog');
const exForm = $('#ex-form');
const fields = exForm.elements;
$('#ex-stress').innerHTML = injuryBoxes('stress');

function openEditor(id) {
  editingId = id;
  const ex = id ? catalog.items.find(x => x.id === id) : {
    name: '', equipment: '', muscle: '', target: '', helpers: '',
    kind: 'isolation', region: 'upper', stress: [], active: true,
  };
  $('#ex-title').textContent = id ? 'Изменить упражнение' : 'Новое упражнение';
  fields.muscle.innerHTML = '<option value="">— выберите —</option>' +
    Object.entries(catalog.muscles).map(([k, label]) =>
      `<option value="${k}">${esc(label)}</option>`).join('');
  for (const f of ['name', 'equipment', 'muscle', 'target', 'helpers', 'kind', 'region']) {
    fields[f].value = ex[f] || '';
  }
  fields.active.checked = ex.active;
  exForm.querySelectorAll('[name=stress]').forEach(c => { c.checked = ex.stress.includes(c.value); });
  $('#ex-error').textContent = '';
  dialog.showModal();
}

$('#add-ex').addEventListener('click', () => openEditor(null));
$('#ex-cancel').addEventListener('click', () => dialog.close());

exForm.addEventListener('submit', async e => {
  e.preventDefault();
  const f = fields;
  const data = {
    name: f.name.value, equipment: f.equipment.value, muscle: f.muscle.value,
    target: f.target.value, helpers: f.helpers.value, kind: f.kind.value,
    region: f.region.value, active: f.active.checked,
    stress: [...exForm.querySelectorAll('[name=stress]:checked')].map(c => c.value),
  };
  try {
    if (editingId) await api('PUT', `/api/exercises/${editingId}`, data);
    else await api('POST', '/api/exercises', data);
    dialog.close();
    toast('Сохранено ✓');
    loadCatalog();
  } catch (err) {
    $('#ex-error').textContent = err.message;
  }
});

// ---------- запуск ----------

renderNav('settings');
(async () => {
  let me;
  try { me = await requireAuth(); } catch (e) { return; }
  fillProfile(me.profile);
  showTab(location.hash === '#catalog' ? 'catalog' : 'profile');
  loadCatalog();
})();
