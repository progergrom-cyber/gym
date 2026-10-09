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

// ---------- оформление ----------

function renderThemes() {
  const cur = store.get('theme', 'lime');
  $('#themes').innerHTML = Object.entries(THEMES).map(([id, t]) => `
    <button type="button" class="theme-opt ${id === cur ? 'on' : ''}" data-theme-id="${id}"
      aria-pressed="${id === cur}">
      <span class="theme-prev"><i style="background:${t.bg}"></i><i style="background:${t.s}"></i>
        <i style="background:${t.a}"></i><i style="background:${t.b}"></i></span>
      <b>${esc(t.name)}</b><small>${esc(t.desc)}</small>
    </button>`).join('');
}
$('#themes').addEventListener('click', e => {
  const b = e.target.closest('[data-theme-id]');
  if (!b) return;
  store.set('theme', b.dataset.themeId);
  applyTheme(b.dataset.themeId);
  renderThemes();
  toast('Оформление: ' + THEMES[b.dataset.themeId].name);
});
renderThemes();

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
          const mineOff = items.find(e => e.muscle === m.muscle && e.club_active && !e.mine);
          const clubOff = items.find(e => e.muscle === m.muscle && !e.club_active);
          return `<li><b>${esc(m.label)}</b>: ${mineOff
            ? `вы выключили «${esc(mineOff.name)}» — включите, если подходит`
            : clubOff
              ? `«${esc(clubOff.name)}» отмечено как «нет в клубе» — откройте его, если тренажёр есть`
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
          <button class="row-btn" type="button">
            <span class="thumb">${e.photo_url
              ? `<img src="${esc(e.photo_url)}" alt="" loading="lazy">` : DUMBBELL_SVG}</span>
            <span class="grow">
              ${esc(e.name)}
              <small>${e.club_active ? '' : '<b class="off-label">нет в клубе</b> · '}${esc(e.equipment || '—')} · ${e.kind === 'compound' ? 'база' : 'изоляция'}${
                e.stress.length ? ' · ⚠ ' + e.stress.map(s => INJURY_LABELS[s]).join(', ') : ''}</small>
            </span>
          </button>
          <label class="switch" aria-label="Использовать в моих планах">
            <input type="checkbox" class="toggle" ${e.mine && e.club_active ? 'checked' : ''}><span></span>
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
    if (!ex.club_active) {
      // Упражнение отмечено «нет в клубе» для всех — спросим, вернуть ли
      if (!confirm(`«${ex.name}» отмечено как «нет в клубе» для всех. Тренажёр есть в зале? Вернуть его в каталог для всех?`)) {
        e.target.checked = false;
        return;
      }
      await api('PUT', `/api/exercises/${id}`, { ...ex, club_active: true });
      await api('PUT', `/api/exercises/${id}/mine`, { enabled: true });
      toast('Упражнение вернулось в каталог');
      loadCatalog();
      return;
    }
    await api('PUT', `/api/exercises/${id}/mine`, { enabled: e.target.checked });
    toast(e.target.checked ? 'Будет попадать в ваши планы' : 'Больше не попадёт в ваши планы');
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
    name: '', equipment: '', muscle: '', target: '', helpers: '', tips: '',
    kind: 'isolation', region: 'upper', stress: [], active: true,
  };
  $('#ex-title').textContent = id ? 'Изменить упражнение' : 'Новое упражнение';
  fields.muscle.innerHTML = '<option value="">— выберите —</option>' +
    Object.entries(catalog.muscles).map(([k, label]) =>
      `<option value="${k}">${esc(label)}</option>`).join('');
  for (const f of ['name', 'equipment', 'muscle', 'target', 'helpers', 'kind', 'region', 'tips']) {
    fields[f].value = ex[f] || '';
  }
  fields.active.checked = id ? ex.club_active : true;
  exForm.querySelectorAll('[name=stress]').forEach(c => { c.checked = ex.stress.includes(c.value); });
  $('#ex-error').textContent = '';
  photoChange = null;
  currentPhoto = ex.photo_url || null;
  renderPhotoBox();
  dialog.showModal();
}

// ---------- фото тренажёра ----------

let photoChange = null;   // null — без изменений, Blob — новое фото, 'delete' — удалить
let currentPhoto = null;  // адрес текущего фото на сервере
let previewUrl = null;

function renderPhotoBox() {
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  let src = null;
  if (photoChange instanceof Blob) src = previewUrl = URL.createObjectURL(photoChange);
  else if (photoChange !== 'delete') src = currentPhoto;
  $('#ex-photo-box').innerHTML = src
    ? `<img src="${esc(src)}" alt="Фото тренажёра">`
    : 'Фото нет — сфотографируйте тренажёр, чтобы его было легко найти в зале';
  $('#ex-photo-pick').textContent = src ? '📷 Заменить' : '📷 Добавить фото';
  $('#ex-photo-del').hidden = !src;
}

// Уменьшаем фото на телефоне до ~1000 px, чтобы оно весило 100–200 КБ
async function compressImage(file, maxSide = 1000, quality = 0.82) {
  let img;
  try {
    img = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Не удалось открыть картинку'));
      el.src = URL.createObjectURL(file);
    });
  }
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(
    b => (b ? resolve(b) : reject(new Error('Не удалось сжать фото'))), 'image/jpeg', quality));
}

$('#ex-photo-pick').addEventListener('click', () => $('#ex-photo-input').click());
$('#ex-photo-del').addEventListener('click', () => { photoChange = 'delete'; renderPhotoBox(); });
$('#ex-photo-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    photoChange = await compressImage(file);
    renderPhotoBox();
  } catch (err) {
    toast(err.message);
  }
});
$('#ex-photo-box').addEventListener('click', () => {
  const img = $('#ex-photo-box img');
  if (img) showPhoto(img.src);
});

async function savePhoto(exId) {
  if (photoChange instanceof Blob) {
    const form = new FormData();
    form.append('photo', photoChange, 'photo.jpg');
    await api('POST', `/api/exercises/${exId}/photo`, form);
  } else if (photoChange === 'delete' && currentPhoto) {
    await api('DELETE', `/api/exercises/${exId}/photo`);
  }
}

$('#add-ex').addEventListener('click', () => openEditor(null));
$('#ex-cancel').addEventListener('click', () => dialog.close());

exForm.addEventListener('submit', async e => {
  e.preventDefault();
  const f = fields;
  const data = {
    name: f.name.value, equipment: f.equipment.value, muscle: f.muscle.value,
    target: f.target.value, helpers: f.helpers.value, kind: f.kind.value,
    region: f.region.value, club_active: f.active.checked, tips: f.tips.value,
    stress: [...exForm.querySelectorAll('[name=stress]:checked')].map(c => c.value),
  };
  try {
    let id = editingId;
    if (id) await api('PUT', `/api/exercises/${id}`, data);
    else id = (await api('POST', '/api/exercises', data)).id;
    editingId = id;  // если фото не загрузится, повторное «Сохранить» не создаст дубль
    await savePhoto(id);
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
