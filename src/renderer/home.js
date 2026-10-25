// Home window: navigation, device actions, setup and preferences.
//
// Falls back to a demo dataset when it runs outside Electron (window.timbre
// absent), so the layout can be reviewed in a plain browser.

const DEMO = !window.timbre;

const api = window.timbre || demoApi();

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let state = null;

// ---- Navigation ----------------------------------------------------------

function showView(name) {
  $$('.nav__item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === name));
}

$$('.nav__item').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
document.addEventListener('click', (e) => {
  const goto = e.target.closest('[data-goto]');
  if (goto) showView(goto.dataset.goto);
});

// ---- Icons helper --------------------------------------------------------

function icon(id) {
  return `<svg class="ico"><use href="#${id}" /></svg>`;
}

// ---- Render --------------------------------------------------------------

function render() {
  if (!state) return;
  renderStatus();
  renderDevices();
  renderSettings();
}

function renderStatus() {
  const pill = $('#status-pill');
  const text = $('#status-text');
  pill.classList.remove('is-on', 'is-mid', 'is-off');
  if (state.configured && state.fcmActive) {
    pill.classList.add('is-on');
    text.textContent = 'A la escucha';
  } else if (state.configured) {
    pill.classList.add('is-mid');
    text.textContent = 'Conectando…';
  } else {
    pill.classList.add('is-off');
    text.textContent = 'Sin configurar';
  }
}

function renderDevices() {
  const grid = $('#devices-grid');
  const empty = $('#devices-empty');
  if (!state.configured) {
    empty.classList.remove('hidden');
    grid.classList.add('hidden');
    grid.innerHTML = '';
    return;
  }
  empty.classList.add('hidden');
  grid.classList.remove('hidden');

  const online = state.fcmActive;
  grid.innerHTML = (state.devices || [])
    .map((d) => {
      const name = d.tag || 'Portero';
      const doors = d.doors && d.doors.length ? d.doors : [{ name: null, title: 'puerta' }];
      const doorBtns = doors
        .map(
          (door) =>
            `<button class="btn btn--ghost" data-door="${esc(d.deviceId)}" data-door-name="${esc(door.name || '')}">
               ${icon('i-key')}Abrir ${esc(doors.length > 1 ? door.title : 'puerta')}
             </button>`
        )
        .join('');
      return `
        <article class="device">
          <div class="device__face">
            <div class="device__lens"></div>
            <span class="device__state ${online ? '' : 'is-off'}"><span class="dot"></span>${online ? 'Disponible' : 'Sin conexión'}</span>
          </div>
          <div class="device__body">
            <div>
              <span class="device__name">${esc(name)}</span>
              <span class="device__tag">${d.cameras > 1 ? d.cameras + ' cámaras' : d.canSwitch ? 'Varias cámaras' : 'Cámara'}${d.master ? ' · titular' : ''}</span>
            </div>
            <div class="device__actions">
              <button class="btn btn--primary" data-camera="${esc(d.deviceId)}">${icon('i-camera')}Ver cámara</button>
            </div>
            <div class="device__doors">${doorBtns}</div>
          </div>
        </article>`;
    })
    .join('');
}

function renderSettings() {
  const configured = state.configured;
  $('#setup').classList.toggle('hidden', configured);
  $('#connected').classList.toggle('hidden', !configured);
  $('#prefs').classList.toggle('hidden', !configured);

  // Setup step states
  $('#step-apk').classList.toggle('is-done', !!state.firebase);
  $('#step-login').classList.toggle('is-done', configured);
  $('#btn-login').disabled = !state.firebase;

  if (configured) {
    $('#conn-account').textContent = state.account ? `Conectado como ${state.account}` : 'Conectado';
    const app = state.app ? `DuoxMe ${state.app.versionName || ''}`.trim() : '';
    const dev = (state.devices || []).length;
    $('#conn-meta').textContent = [app, dev ? `${dev} ${dev === 1 ? 'portero' : 'porteros'}` : '']
      .filter(Boolean)
      .join(' · ');

    const s = state.settings || {};
    $('#set-force').checked = !!s.ringForcesSound;
    $('#set-video').checked = !!s.showVideoOnRing;
    $('#set-autostart').checked = !!s.autostart;
    $('#set-volume').value = s.ringVolume ?? 0.9;
  }
}

// ---- Device actions ------------------------------------------------------

document.addEventListener('click', async (e) => {
  const cam = e.target.closest('[data-camera]');
  if (cam) {
    cam.disabled = true;
    toast('Activando cámara…');
    const res = await api.openCamera(cam.dataset.camera);
    cam.disabled = false;
    if (res?.error) toast(res.error, 'err');
    return;
  }
  const door = e.target.closest('[data-door]');
  if (door) {
    door.disabled = true;
    const res = await api.openDoorDevice(door.dataset.door, door.dataset.doorName || undefined);
    door.disabled = false;
    toast(res?.ok ? 'Puerta abierta' : res?.error || 'No se pudo abrir', res?.ok ? 'ok' : 'err');
  }
});

// ---- Setup actions -------------------------------------------------------

$('#btn-apk').addEventListener('click', async () => {
  setNote('#apk-result', 'Leyendo el APK…');
  const res = await api.pickAndExtractApk();
  if (res.canceled) return setNote('#apk-result', '');
  if (res.error) return setNote('#apk-result', res.error, 'err');
  setNote(
    '#apk-result',
    `Leído: DuoxMe ${res.app?.versionName || '?'} · ${res.urlsConfirmed ? 'URLs verificadas' : 'URLs sin verificar'}`,
    'ok'
  );
  $('#btn-login').disabled = false;
});

$('#btn-login').addEventListener('click', async () => {
  const username = $('#acc-user').value.trim();
  const password = $('#acc-pass').value;
  if (!username || !password) return setNote('#login-result', 'Escribe correo y contraseña', 'err');
  setNote('#login-result', 'Iniciando sesión…');
  const res = await api.saveAccount({ username, password });
  if (res.error) return setNote('#login-result', res.error, 'err');
  setNote('#login-result', 'Sesión iniciada', 'ok');
  $('#acc-pass').value = '';
});

$('#btn-reconfig').addEventListener('click', () => {
  $('#setup').classList.remove('hidden');
  $('#setup').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ---- Preferences ---------------------------------------------------------

$('#set-force').addEventListener('change', (e) => api.setSettings({ ringForcesSound: e.target.checked }));
$('#set-video').addEventListener('change', (e) => api.setSettings({ showVideoOnRing: e.target.checked }));
$('#set-autostart').addEventListener('change', (e) => api.setSettings({ autostart: e.target.checked }));
$('#set-volume').addEventListener('change', (e) => api.setSettings({ ringVolume: parseFloat(e.target.value) }));

// ---- Log -----------------------------------------------------------------

const logEl = $('#log');
let logEmpty = true;

function appendLog(line) {
  if (logEmpty) {
    logEl.innerHTML = '';
    logEmpty = false;
  }
  const m = line.match(/^\[([^\]]+)\]\s*(.*)$/);
  let time = '';
  let msg = line;
  if (m) {
    msg = m[2];
    const d = new Date(m[1]);
    time = Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('es-ES');
  }
  const low = msg.toLowerCase();
  const cls = /error|no se pudo|falló|fallo|límite/.test(low)
    ? 'is-err'
    : /cámara|camara|puerta|llamada|aviso|registrado/.test(low)
      ? 'is-call'
      : '';
  const row = document.createElement('div');
  row.className = 'log__row ' + cls;
  row.innerHTML = `<span class="log__time">${esc(time)}</span><span class="log__msg">${esc(msg)}</span>`;
  logEl.appendChild(row);
  logEl.scrollTop = logEl.scrollHeight;
}

function resetLog() {
  logEl.innerHTML = '<div class="log__empty">Todavía no hay actividad.</div>';
  logEmpty = true;
}

$('#log-clear').addEventListener('click', resetLog);

// ---- Helpers -------------------------------------------------------------

function setNote(sel, text, kind) {
  const el = $(sel);
  el.textContent = text;
  el.className = 'note' + (kind ? ' ' + kind : '');
}

let toastTimer;
function toast(text, kind) {
  const t = $('#toast');
  t.textContent = text;
  t.className = 'toast show' + (kind ? ' is-' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- Wire up -------------------------------------------------------------

resetLog();
api.onState((s) => {
  state = s;
  render();
});
api.onLog(appendLog);
api.requestState();

// ---- Demo fallback (browser preview only) --------------------------------

function demoApi() {
  const state = {
    configured: true,
    account: 'ignacio+pc@gmail.com',
    app: { versionName: '4.4.1', applicationId: 'com.fermax.blue.app' },
    firebase: { projectId: 'fermax-blue' },
    devices: [
      { deviceId: 'A', tag: 'Puerta principal', master: true, cameras: 2, doors: [{ name: 'g', title: 'Portal' }, { name: 'z', title: 'Garaje' }] },
      { deviceId: 'B', tag: 'Chalet', master: false, cameras: 1, doors: [{ name: null, title: 'puerta' }] },
    ],
    activeDeviceId: 'A',
    fcmActive: true,
    settings: { ringForcesSound: true, showVideoOnRing: true, autostart: true, ringVolume: 0.9 },
  };
  const logs = [
    `[${new Date().toISOString()}] Registrado para recibir llamadas. Token FCM activo.`,
    `[${new Date().toISOString()}] Aviso recibido: Call (Puerta principal)`,
    `[${new Date().toISOString()}] Puerta abierta: Portal (Puerta principal)`,
  ];
  return {
    onState: (cb) => setTimeout(() => cb(state), 0),
    onLog: (cb) => logs.forEach((l) => setTimeout(() => cb(l), 0)),
    requestState: () => {},
    pickAndExtractApk: async () => ({ ok: true, app: { versionName: '4.4.1' }, urlsConfirmed: true }),
    saveAccount: async () => ({ ok: true }),
    setSettings: async () => {},
    openCamera: async () => ({ ok: true }),
    openDoorDevice: async () => ({ ok: true }),
    simulateCall: async () => ({ ok: true }),
  };
}

void DEMO;
