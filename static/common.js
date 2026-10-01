'use strict';
// Общие функции для всех страниц.

const $ = (sel, root = document) => root.querySelector(sel);

const GOAL_LABELS = {
  hypertrophy: 'Набор мышечной массы',
  strength: 'Сила',
  maintain: 'Поддержание формы',
};
const INJURY_LABELS = {
  knees: 'колени', lower_back: 'поясница', shoulders: 'плечи', elbows: 'локти',
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Хранилище на телефоне (localStorage). Всё обёрнуто в try на случай,
// если браузер его запретил.
const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem('gym_' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('gym_' + key, JSON.stringify(value)); } catch (e) { /* нет места */ }
  },
  del(key) {
    try { localStorage.removeItem('gym_' + key); } catch (e) { /* ничего */ }
  },
  clearAll() {
    try {
      Object.keys(localStorage).filter(k => k.startsWith('gym_'))
        .forEach(k => localStorage.removeItem(k));
    } catch (e) { /* ничего */ }
  },
};

class ApiError extends Error {
  constructor(message, status, offline = false) {
    super(message);
    this.status = status;
    this.offline = offline;
  }
}

// Запрос к серверу. Возвращает JSON или бросает ApiError.
async function api(method, path, data) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (data instanceof FormData) {
    opts.body = data;  // файл (фото) — браузер сам выставит заголовки
  } else if (data !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(data);
  }
  let resp;
  try {
    resp = await fetch(path, opts);
  } catch (e) {
    throw new ApiError('Нет связи с сервером. Проверьте интернет.', 0, true);
  }
  let json = {};
  try { json = await resp.json(); } catch (e) { /* не JSON */ }
  if (resp.status === 401 && path !== '/api/login') {
    store.del('me');
    if (location.pathname !== '/login') location.href = '/login';
    throw new ApiError(json.error || 'Нужно войти', 401);
  }
  if (!resp.ok) {
    throw new ApiError(json.error || `Ошибка сервера (${resp.status})`, resp.status);
  }
  return json;
}

let toastTimer = null;
function toast(message, ms = 3000) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- даты и числа ----------

function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function fmtDate(iso, withWeekday = true) {
  const d = new Date(iso + 'T12:00:00');
  const opts = { day: 'numeric', month: 'short' };
  if (withWeekday) opts.weekday = 'short';
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('ru-RU', opts);
}

function fmtNum(n) {
  if (n === null || n === undefined || n === '') return '';
  return String(Math.round(n * 100) / 100).replace('.', ',');
}

function parseNum(s) {
  const v = parseFloat(String(s ?? '').replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

function fmtSec(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.max(0, sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------- меню и вход ----------

const ICONS = {
  workout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 7v10M18 7v10M3 10v4M21 10v4M6 12h12"/></svg>',
  progress: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20h18M5 16l4-5 4 3 6-8"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
};

// Заглушка вместо фото тренажёра
const DUMBBELL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 7v10M18 7v10M3 10v4M21 10v4M6 12h12"/></svg>';

// Показать фото на весь экран (нажатие закрывает)
function showPhoto(url) {
  let dlg = $('#photo-view');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'photo-view';
    dlg.className = 'photo-view';
    dlg.innerHTML = '<img alt="Фото тренажёра">';
    dlg.addEventListener('click', () => dlg.close());
    document.body.appendChild(dlg);
  }
  dlg.querySelector('img').src = url;
  dlg.showModal();
}

function renderNav(active) {
  const tabs = [
    ['workout', '/', 'Тренировка'],
    ['progress', '/progress', 'Прогресс'],
    ['settings', '/settings', 'Профиль'],
  ];
  const nav = document.createElement('nav');
  nav.className = 'tabbar';
  nav.innerHTML = tabs.map(([key, href, label]) =>
    `<a href="${href}" class="${key === active ? 'on' : ''}">${ICONS[key]}${label}</a>`
  ).join('');
  document.body.appendChild(nav);
}

function showNetState() {
  const el = $('#net');
  if (el) el.hidden = navigator.onLine;
}
window.addEventListener('online', () => { showNetState(); flushPending(); });
window.addEventListener('offline', showNetState);

// Проверить, что пользователь вошёл. Без интернета берём данные из памяти.
async function requireAuth() {
  try {
    const me = await api('GET', '/api/me');
    store.set('me', me);
    return me;
  } catch (e) {
    const cached = store.get('me');
    if (e.offline && cached) return cached;
    if (e.offline) {
      $('main').innerHTML = '<div class="note warn">Нет интернета. ' +
        'Откройте приложение, когда появится связь.</div>';
    }
    throw e;
  }
}

// Тренировки, сохранённые без интернета, отправляем при первой возможности.
let flushing = null;
function flushPending() {
  if (!flushing) {
    flushing = (async () => {
      const queue = store.get('pending', []);
      const left = [];
      for (const item of queue) {
        try {
          await api('POST', `/api/workouts/${item.workout_id}/finish`, item.payload);
        } catch (e) {
          if (e.offline || e.status === 401 || e.status >= 500) left.push(item);
        }
      }
      store.set('pending', left);
      return queue.length - left.length;
    })().finally(() => { flushing = null; });
  }
  return flushing;
}

async function logout() {
  if (store.get('pending', []).length &&
      !confirm('Есть тренировка, которая ещё не отправлена на сервер. Выйти всё равно? Она пропадёт.')) {
    return;
  }
  try { await api('POST', '/api/logout', {}); } catch (e) { /* выйдем локально */ }
  store.clearAll();
  if ('caches' in window) await caches.delete('gym-api');
  location.href = '/login';
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* не страшно */ });
  });
}
document.addEventListener('DOMContentLoaded', showNetState);
