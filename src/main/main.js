'use strict';

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, dialog, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { createStores } = require('./store');
const { extractCredentials } = require('./apk/extract');
const { FermaxApi, FermaxAuthError } = require('./fermax-api');
const { PushListener } = require('./push');

const isDev = process.argv.includes('--dev');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const ASSETS_DIR = path.join(__dirname, '..', '..', 'assets');

// Only one instance: a second launch just surfaces the running one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let stores;
let api = null;
let push = null;
let tray = null;
let homeWindow = null;
let callWindow = null;
let pairings = [];
let quitting = false;

// ---------------------------------------------------------------------------
// Credentials / API / push wiring
// ---------------------------------------------------------------------------

function haveCredentials() {
  const c = stores.credentials;
  return !!(c.get('firebase') && c.get('fermax') && c.get('account'));
}

function buildApi() {
  const fermax = stores.credentials.get('fermax');
  const account = stores.credentials.get('account');
  if (!fermax || !account) return null;
  return new FermaxApi({
    authUrl: fermax.authUrl,
    baseUrl: fermax.baseUrl,
    authBasic: fermax.authBasic,
    getAccount: () => stores.credentials.get('account'),
    tokens: stores.credentials.get('tokens') || undefined,
    onToken: (tokens) => stores.credentials.set('tokens', tokens),
  });
}

async function startServices() {
  api = buildApi();
  if (!api) return;

  // Load pairings so we know devices and door access ids.
  try {
    pairings = await api.getPairings();
    const active = stores.settings.get('activeDeviceId');
    if (!active && pairings[0]) stores.settings.set('activeDeviceId', pairings[0].deviceId);
  } catch (err) {
    log('No se pudieron cargar los emparejamientos: ' + err.message);
  }

  await startPush();
  updateTrayMenu();
  broadcastState();
}

async function startPush() {
  const firebase = stores.credentials.get('firebase');
  if (!firebase) return;
  if (push) await push.stop();

  push = new PushListener({
    firebase,
    credentials: stores.credentials.get('fcm'),
    persistentIds: stores.credentials.get('persistentIds') || [],
    onCredentials: (creds) => stores.credentials.set('fcm', creds),
    onPersistentIds: (ids) => stores.credentials.set('persistentIds', ids),
  });

  push.on('notification', onPushNotification);
  push.on('error', (err) => log('Push: ' + err.message));
  push.on('token', () => broadcastState());

  try {
    const token = await push.start();
    if (token) {
      const res = await api.registerAppToken(token, { active: true });
      if (res.sessionLimit) {
        log('Límite de sesiones alcanzado al registrar el token. Usa una cuenta dedicada para el PC.');
        notifyInfo(
          'Timbre: límite de sesiones',
          'Fermax no admite más dispositivos en esta cuenta. Crea un usuario invitado para el PC.'
        );
      } else {
        log('Registrado para recibir llamadas. Token FCM activo.');
      }
    }
  } catch (err) {
    log('No se pudo iniciar la escucha de avisos: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Incoming push handling
// ---------------------------------------------------------------------------

async function onPushNotification(n) {
  log(`Aviso recibido: ${n.type}${n.deviceId ? ' (' + n.deviceId + ')' : ''}`);

  if (n.sendAck && n.messageId) {
    const isCall = ['Call', 'CallAttend', 'CallEnd'].includes(n.type);
    api.ackNotification(n.messageId, { isCall }).catch(() => {});
  }

  if (n.type === 'Call') {
    await handleIncomingCall(n);
  } else if (n.type === 'CallEnd') {
    endCall('remote');
  } else if (n.type === 'Logout') {
    notifyInfo('Timbre', 'La sesión se ha cerrado desde otro dispositivo.');
    broadcastState();
  } else if (n.type === 'Info' && (n.title || n.body)) {
    notifyInfo(n.title || 'Timbre', n.body || '');
  }
}

async function handleIncomingCall(n) {
  const deviceName = deviceLabel(n.deviceId);

  // Fetch the visitor photo if the push referenced one (best effort).
  let photoDataUrl = null;
  if (n.raw && n.raw.PhotoId) {
    try {
      const buf = await api.getCallPhoto(n.raw.PhotoId);
      if (buf) photoDataUrl = 'data:image/jpeg;base64,' + buf.toString('base64');
    } catch {
      /* no photo */
    }
  }

  const callInfo = {
    deviceId: n.deviceId,
    callAs: n.callAs,
    roomId: n.roomId,
    signalingUrl: n.signalingUrl || stores.credentials.get('fermax').signalingUrl,
    accessDoorKey: n.accessDoorKey,
    conversationTimeout: n.conversationTimeout || 90,
    previewTimeout: n.previewTimeout || 30,
    deviceName,
    title: n.title || 'Llamada del portero',
    body: n.body || deviceName,
    photoDataUrl,
    oauthToken: await api.getAccessToken().catch(() => ''),
    fcmToken: push?.fcmToken || '',
  };

  showCallWindow(callInfo);

  // System toast too, so it reaches the user even if the window is covered.
  notifyInfo(callInfo.title, callInfo.body, { urgent: true });
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function appIcon() {
  const p = path.join(ASSETS_DIR, 'icon.png');
  return fs.existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty();
}

function createHomeWindow() {
  if (homeWindow) {
    homeWindow.show();
    homeWindow.focus();
    return homeWindow;
  }
  homeWindow = new BrowserWindow({
    width: 480,
    height: 640,
    minWidth: 400,
    minHeight: 520,
    show: false,
    icon: appIcon(),
    title: 'Timbre',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  homeWindow.loadFile(path.join(RENDERER_DIR, 'home.html'));
  homeWindow.once('ready-to-show', () => {
    if (!stores.settings.get('startMinimized') || !haveCredentials()) homeWindow.show();
    broadcastState();
  });
  homeWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      homeWindow.hide();
    }
  });
  return homeWindow;
}

function showCallWindow(callInfo) {
  if (!callWindow) {
    callWindow = new BrowserWindow({
      width: 420,
      height: 620,
      show: false,
      frame: false,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: false,
      icon: appIcon(),
      title: 'Llamada',
      backgroundColor: '#11131a',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    callWindow.loadFile(path.join(RENDERER_DIR, 'call.html'));
    callWindow.on('closed', () => {
      callWindow = null;
    });
  }
  const send = () => {
    callWindow.show();
    callWindow.focus();
    callWindow.setAlwaysOnTop(true, 'screen-saver');
    callWindow.webContents.send('incoming-call', {
      ...callInfo,
      settings: {
        ringSound: stores.settings.get('ringSound'),
        ringVolume: stores.settings.get('ringVolume'),
        ringForcesSound: stores.settings.get('ringForcesSound'),
        showVideo: stores.settings.get('showVideoOnRing'),
      },
    });
  };
  if (callWindow.webContents.isLoading()) {
    callWindow.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

function endCall(reason) {
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.webContents.send('call:ended', { reason });
  }
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function createTray() {
  tray = new Tray(appIcon());
  tray.setToolTip('Timbre — portero Fermax');
  tray.on('click', () => createHomeWindow());
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const deviceItems = pairings.map((p) => ({
    label: (p.tag || p.deviceId) + (p.deviceId === stores.settings.get('activeDeviceId') ? '  ✓' : ''),
    click: () => {
      stores.settings.set('activeDeviceId', p.deviceId);
      updateTrayMenu();
      broadcastState();
    },
  }));

  const menu = Menu.buildFromTemplate([
    { label: haveCredentials() ? 'Timbre: a la escucha' : 'Timbre: sin configurar', enabled: false },
    { type: 'separator' },
    { label: 'Abrir ventana', click: () => createHomeWindow() },
    ...(deviceItems.length ? [{ type: 'separator' }, { label: 'Dispositivo activo', enabled: false }, ...deviceItems] : []),
    { type: 'separator' },
    { label: 'Salir', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deviceLabel(deviceId) {
  const p = pairings.find((x) => x.deviceId === deviceId);
  return p ? p.tag || p.deviceId : deviceId || 'Portero';
}

function activeDevice() {
  const id = stores.settings.get('activeDeviceId');
  return pairings.find((p) => p.deviceId === id) || pairings[0] || null;
}

function notifyInfo(title, body, { urgent = false } = {}) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, urgency: urgent ? 'critical' : 'normal', silent: false });
  n.on('click', () => {
    if (callWindow) {
      callWindow.show();
      callWindow.focus();
    } else {
      createHomeWindow();
    }
  });
  n.show();
}

function broadcastState() {
  const state = {
    configured: haveCredentials(),
    account: stores.credentials.get('account')?.username || null,
    app: stores.credentials.get('app') || null,
    firebase: stores.credentials.get('firebase')
      ? { projectId: stores.credentials.get('firebase').projectId, packageName: stores.credentials.get('firebase').packageName }
      : null,
    devices: pairings.map((p) => ({ deviceId: p.deviceId, tag: p.tag, master: p.master })),
    activeDeviceId: stores.settings.get('activeDeviceId'),
    fcmActive: !!push?.fcmToken,
    settings: stores.settings.all(),
  };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('state', state);
  }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('log', line);
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('state:get', () => {
  broadcastState();
  return true;
});

ipcMain.handle('apk:pick-and-extract', async () => {
  const result = await dialog.showOpenDialog(homeWindow || undefined, {
    title: 'Selecciona el APK de DuoxMe (base.apk y, si lo tienes, los splits)',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'APK', extensions: ['apk', 'xapk', 'apks', 'zip'] }],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  try {
    const creds = await extractCredentials(result.filePaths);
    stores.credentials.set('firebase', creds.firebase);
    stores.credentials.set('fermax', creds.fermax);
    stores.credentials.set('app', creds.app);
    return { ok: true, app: creds.app, firebase: { projectId: creds.firebase.projectId }, urlsConfirmed: creds.fermax.urlsConfirmedInApk };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('account:save', async (_e, { username, password }) => {
  if (!username || !password) return { error: 'Faltan usuario o contraseña' };
  stores.credentials.set('account', { username, password });
  stores.credentials.set('tokens', null);
  // Verify by authenticating once.
  try {
    const probe = buildApi();
    await probe.authenticate();
  } catch (err) {
    stores.credentials.set('account', null);
    return { error: err instanceof FermaxAuthError ? err.message : 'No se pudo iniciar sesión: ' + err.message };
  }
  await startServices();
  return { ok: true };
});

ipcMain.handle('settings:set', (_e, patch) => {
  stores.settings.merge(patch || {});
  updateTrayMenu();
  broadcastState();
  return stores.settings.all();
});

ipcMain.handle('call:open-door', async (_e, info) => {
  try {
    const device = activeDevice();
    if (info && info.roomId && info.deviceId) {
      await api.openDoorInCall({
        deviceId: info.deviceId,
        roomId: info.roomId,
        fcmToken: push?.fcmToken,
        callAs: info.callAs || info.deviceId,
      });
      return { ok: true };
    }
    if (!device) return { error: 'No hay dispositivo activo' };
    const door = Object.values(device.accessDoors).find((d) => d.visible) || Object.values(device.accessDoors)[0];
    if (!door) return { error: 'No se encontró ninguna puerta' };
    await api.openDoor(device.deviceId, door.accessId, door.panelId);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('call:dismiss', () => {
  if (callWindow && !callWindow.isDestroyed()) callWindow.hide();
  return true;
});

ipcMain.handle('call:log', (_e, line) => {
  log('[llamada] ' + line);
  return true;
});

ipcMain.on('call:hide', () => {
  if (callWindow && !callWindow.isDestroyed()) callWindow.hide();
});

// Dev/testing: simulate an incoming call without the cloud.
ipcMain.handle('debug:simulate-call', async () => {
  const device = activeDevice();
  await handleIncomingCall({
    type: 'Call',
    deviceId: device?.deviceId || 'TEST-DEVICE',
    callAs: device?.deviceId || 'TEST-DEVICE',
    roomId: null,
    signalingUrl: stores.credentials.get('fermax')?.signalingUrl || '',
    title: 'Llamada de prueba',
    body: 'Simulación local (sin vídeo)',
    conversationTimeout: 90,
  });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.on('second-instance', () => createHomeWindow());

app.whenReady().then(async () => {
  stores = createStores(app.getPath('userData'));

  if (process.platform === 'win32') app.setAppUserModelId('com.ignacioaranda.timbre');

  // Autostart on login (Windows/Linux).
  app.setLoginItemSettings({ openAtLogin: !!stores.settings.get('autostart'), openAsHidden: true });

  createTray();
  createHomeWindow();

  if (haveCredentials()) {
    await startServices();
  }

  app.on('activate', () => createHomeWindow());

  // Smoke test hook: prove the full main process boots and windows render,
  // then exit. Never used in normal runs.
  if (process.env.TIMBRE_SMOKE) {
    const marker = path.isAbsolute(process.env.TIMBRE_SMOKE)
      ? process.env.TIMBRE_SMOKE
      : path.join(app.getPath('temp'), process.env.TIMBRE_SMOKE);
    const ok = {
      homeWindow: !!homeWindow,
      tray: !!tray,
      configured: haveCredentials(),
      windows: BrowserWindow.getAllWindows().length,
    };
    const checkRender = () => {
      homeWindow.webContents
        .executeJavaScript('!!document.getElementById("badge")')
        .then((hasBadge) => {
          fs.writeFileSync(marker, JSON.stringify({ ...ok, rendererOk: hasBadge }, null, 2));
          setTimeout(() => app.exit(0), 300);
        })
        .catch((err) => {
          fs.writeFileSync(marker, JSON.stringify({ ...ok, rendererError: err.message }, null, 2));
          setTimeout(() => app.exit(1), 300);
        });
    };
    if (homeWindow.webContents.isLoading()) {
      homeWindow.webContents.once('did-finish-load', checkRender);
    } else {
      checkRender();
    }
  }
});

app.on('window-all-closed', (e) => {
  // Keep running in the tray.
  e.preventDefault?.();
});

app.on('before-quit', async () => {
  quitting = true;
  if (push && api && push.fcmToken) {
    try {
      await api.unregisterAppToken(push.fcmToken);
    } catch {
      /* ignore */
    }
  }
  if (push) await push.stop();
});

void shell;
void isDev;
