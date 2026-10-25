// Home window: setup wizard, live status and preferences.

const api = window.timbre;
const el = (id) => document.getElementById(id);

let state = null;

function setBadge(configured, fcmActive) {
  const badge = el('badge');
  if (configured && fcmActive) {
    badge.textContent = 'A la escucha';
    badge.className = 'badge badge-on';
  } else if (configured) {
    badge.textContent = 'Conectando…';
    badge.className = 'badge badge-mid';
  } else {
    badge.textContent = 'Sin configurar';
    badge.className = 'badge badge-off';
  }
}

function markStep(num, done) {
  const node = el('step' + num + '-num');
  if (node) node.classList.toggle('done', !!done);
}

api.onState((s) => {
  state = s;
  render();
});

api.onLog((line) => {
  const log = el('log');
  log.textContent += line + '\n';
  log.scrollTop = log.scrollHeight;
});

function render() {
  if (!state) return;
  setBadge(state.configured, state.fcmActive);

  // Setup steps
  const hasApk = !!state.firebase;
  markStep(1, hasApk);
  markStep(2, state.configured);
  el('btn-login').disabled = !hasApk;
  if (hasApk && !el('apk-result').textContent) {
    el('apk-result').textContent = 'App leída: ' + (state.app?.versionName || '?') + ' (' + (state.firebase.projectId || '') + ')';
    el('apk-result').className = 'result ok';
  }

  // Status / settings visibility
  el('status-card').classList.toggle('hidden', !state.configured);
  el('settings-card').classList.toggle('hidden', !state.configured);

  if (state.configured) {
    el('st-account').textContent = state.account || '—';
    el('st-fcm').textContent = state.fcmActive ? 'Activos ✓' : 'Iniciando…';
    el('st-app').textContent = state.app ? state.app.versionName + ' · ' + state.app.applicationId : '—';

    const sel = el('st-device');
    sel.innerHTML = '';
    for (const d of state.devices || []) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = (d.tag || d.deviceId) + (d.master ? ' (titular)' : '');
      if (d.deviceId === state.activeDeviceId) opt.selected = true;
      sel.appendChild(opt);
    }

    const s = state.settings || {};
    el('set-force').checked = !!s.ringForcesSound;
    el('set-video').checked = !!s.showVideoOnRing;
    el('set-autostart').checked = !!s.autostart;
    el('set-volume').value = s.ringVolume ?? 0.9;
  }
}

// --- Setup actions --------------------------------------------------------

el('btn-apk').addEventListener('click', async () => {
  el('apk-result').textContent = 'Leyendo el APK…';
  el('apk-result').className = 'result';
  const res = await api.pickAndExtractApk();
  if (res.canceled) {
    el('apk-result').textContent = '';
    return;
  }
  if (res.error) {
    el('apk-result').textContent = 'Error: ' + res.error;
    el('apk-result').className = 'result err';
    return;
  }
  el('apk-result').textContent =
    'Leído: ' + (res.app?.versionName || '?') + ' · proyecto ' + (res.firebase?.projectId || '?') +
    (res.urlsConfirmed ? ' · URLs verificadas ✓' : ' · ⚠ URLs no verificadas');
  el('apk-result').className = 'result ok';
  el('btn-login').disabled = false;
});

el('btn-login').addEventListener('click', async () => {
  const username = el('acc-user').value.trim();
  const password = el('acc-pass').value;
  el('login-result').textContent = 'Iniciando sesión…';
  el('login-result').className = 'result';
  const res = await api.saveAccount({ username, password });
  if (res.error) {
    el('login-result').textContent = res.error;
    el('login-result').className = 'result err';
    return;
  }
  el('login-result').textContent = 'Sesión iniciada ✓';
  el('login-result').className = 'result ok';
  el('acc-pass').value = '';
});

el('btn-test').addEventListener('click', () => api.simulateCall());

// --- Settings -------------------------------------------------------------

el('st-device').addEventListener('change', (e) => api.setSettings({ activeDeviceId: e.target.value }));
el('set-force').addEventListener('change', (e) => api.setSettings({ ringForcesSound: e.target.checked }));
el('set-video').addEventListener('change', (e) => api.setSettings({ showVideoOnRing: e.target.checked }));
el('set-autostart').addEventListener('change', (e) => api.setSettings({ autostart: e.target.checked }));
el('set-volume').addEventListener('change', (e) => api.setSettings({ ringVolume: parseFloat(e.target.value) }));

api.requestState();
