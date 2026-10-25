'use strict';

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, dialog, nativeImage, shell, nativeTheme, systemPreferences, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Windows 11 (build >= 22000) gets the Mica backdrop and rounded chrome.
const isWin11 = process.platform === 'win32' && Number(os.release().split('.')[2] || 0) >= 22000;

// The OS accent colour, so our primary actions match the system. Windows and
// macOS expose it; elsewhere we fall back to a neutral system blue.
function systemAccent() {
  try {
    const hex = systemPreferences.getAccentColor?.();
    if (hex && hex.length >= 6) return '#' + hex.slice(0, 6);
  } catch {
    /* not available */
  }
  return process.platform === 'win32' ? '#0067c0' : '#3584e4';
}

function themeEnv() {
  return {
    platform: process.platform,
    isWin11,
    accent: systemAccent(),
    dark: nativeTheme.shouldUseDarkColors,
  };
}

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
let flyoutWindow = null;
let sessionActive = false; // a camera/call is live in the flyout
let pairings = [];
let deviceExtras = new Map(); // deviceId -> { panels: [...], canSwitch: bool }
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

  await loadDeviceExtras();
  await startPush();
  updateTrayMenu();
  broadcastState();
}

// Fetch the real camera list and enabled services for each device. The number
// of panels is what tells multi-camera installations apart; the app itself
// shows "switch camera" when the CHANGE_VIDEO_SOURCE service is enabled.
async function loadDeviceExtras() {
  for (const p of pairings) {
    try {
      const [panels, services] = await Promise.all([
        api.getPanels(p.deviceId),
        api.getActiveServices(p.deviceId),
      ]);
      // Only hide "switch camera" when we positively know there is a single
      // panel and no change-video service; otherwise offer it.
      const singleKnown = panels.length === 1 && !services.has('CHANGE_VIDEO_SOURCE');
      deviceExtras.set(p.deviceId, { panels, canSwitch: !singleKnown });
      log(`${p.tag || p.deviceId}: ${panels.length} ${panels.length === 1 ? 'cámara' : 'cámaras'}`);
    } catch (err) {
      log('No se pudieron leer las cámaras de ' + (p.tag || p.deviceId) + ': ' + err.message);
    }
  }
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
    await handleIncomingCall(n, { mode: 'ring' });
  } else if (n.type === 'Autoon') {
    // On-demand camera (we asked the panel to wake): show video, no ringing.
    await handleIncomingCall(n, { mode: 'camera' });
  } else if (n.type === 'ChangeVideoSource') {
    // The panel moved us to another camera: follow it in the flyout if it's up.
    if (sessionActive && flyoutWindow && !flyoutWindow.isDestroyed() && flyoutWindow.isVisible()) {
      await repointCall(n);
    } else {
      await handleIncomingCall(n, { mode: 'camera' });
    }
  } else if (n.type === 'CallEnd') {
    endCall('remote');
  } else if (n.type === 'Logout') {
    notifyInfo('Timbre', 'La sesión se ha cerrado desde otro dispositivo.');
    broadcastState();
  } else if (n.type === 'Info' && (n.title || n.body)) {
    notifyInfo(n.title || 'Timbre', n.body || '');
  }
}

async function buildCallInfo(n, mode) {
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

  return {
    mode, // 'ring' (someone called) | 'camera' (we opened it on demand)
    deviceId: n.deviceId,
    callAs: n.callAs,
    roomId: n.roomId,
    signalingUrl: n.signalingUrl || stores.credentials.get('fermax').signalingUrl,
    accessDoorKey: n.accessDoorKey,
    conversationTimeout: n.conversationTimeout || 90,
    previewTimeout: n.previewTimeout || 30,
    deviceName,
    canSwitchCamera: canSwitchCamera(n.deviceId),
    title: mode === 'camera' ? deviceName : n.title || 'Llamada del portero',
    body: mode === 'camera' ? 'Cámara en directo' : n.body || deviceName,
    photoDataUrl,
    oauthToken: await api.getAccessToken().catch(() => ''),
    fcmToken: push?.fcmToken || '',
  };
}

async function handleIncomingCall(n, { mode }) {
  const callInfo = await buildCallInfo(n, mode);
  sessionActive = true;
  showFlyout();
  sendToFlyout('incoming-call', {
    ...callInfo,
    settings: {
      ringVolume: stores.settings.get('ringVolume'),
      ringForcesSound: stores.settings.get('ringForcesSound'),
      showVideo: stores.settings.get('showVideoOnRing'),
    },
  });
  if (mode === 'ring') {
    // System toast too, so it reaches the user even if the panel is covered.
    notifyInfo(callInfo.title, callInfo.body, { urgent: true });
  }
}

// The panel switched cameras: hand the flyout the new room to re-join.
async function repointCall(n) {
  const callInfo = await buildCallInfo(n, 'camera');
  sendToFlyout('switch-room', callInfo);
}

function endCall(reason) {
  sessionActive = false;
  sendToFlyout('call:ended', { reason });
}

function sendToFlyout(channel, payload) {
  if (flyoutWindow && !flyoutWindow.isDestroyed()) {
    const deliver = () => flyoutWindow.webContents.send(channel, payload);
    if (flyoutWindow.webContents.isLoading()) flyoutWindow.webContents.once('did-finish-load', deliver);
    else deliver();
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function appIcon() {
  const p = path.join(ASSETS_DIR, 'icon.png');
  return fs.existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty();
}

// The tray flyout — the primary surface, anchored bottom-right like the volume
// panel. The full window opens only for Settings/Log.
const FLYOUT_W = 368;
const FLYOUT_H = 540;

function createFlyout() {
  if (flyoutWindow) return flyoutWindow;
  flyoutWindow = new BrowserWindow({
    width: FLYOUT_W,
    height: FLYOUT_H,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    icon: appIcon(),
    title: 'Timbre',
    backgroundColor: isWin11 ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3',
    ...(isWin11 ? { backgroundMaterial: 'mica', roundedCorners: true } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  flyoutWindow.loadFile(path.join(RENDERER_DIR, 'flyout.html'));
  flyoutWindow.on('blur', () => {
    // Behave like the system flyout: close on focus loss, unless a call/camera
    // session is live.
    if (!sessionActive && flyoutWindow.isVisible()) flyoutWindow.hide();
  });
  return flyoutWindow;
}

function positionFlyout() {
  const wa = screen.getPrimaryDisplay().workArea;
  const x = wa.x + wa.width - FLYOUT_W - 12;
  const y = wa.y + wa.height - FLYOUT_H - 12;
  flyoutWindow.setBounds({ x, y, width: FLYOUT_W, height: FLYOUT_H });
}

function showFlyout() {
  createFlyout();
  positionFlyout();
  flyoutWindow.setAlwaysOnTop(true, 'screen-saver');
  flyoutWindow.show();
  flyoutWindow.focus();
}

function toggleFlyout() {
  createFlyout();
  if (flyoutWindow.isVisible() && !sessionActive) flyoutWindow.hide();
  else showFlyout();
}

// The full window: opened on demand for Settings and the Log.
function createHomeWindow(view) {
  if (homeWindow) {
    if (view) homeWindow.webContents.send('go-view', view);
    homeWindow.show();
    homeWindow.focus();
    return homeWindow;
  }
  const dark = nativeTheme.shouldUseDarkColors;
  const opts = {
    width: 940,
    height: 660,
    minWidth: 720,
    minHeight: 560,
    show: false,
    icon: appIcon(),
    title: 'Timbre',
    backgroundColor: dark ? '#202020' : '#f3f3f3',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  if (isWin11) {
    opts.backgroundMaterial = 'mica';
    opts.backgroundColor = '#00000000';
  }
  homeWindow = new BrowserWindow(opts);
  homeWindow.loadFile(path.join(RENDERER_DIR, 'home.html'));
  homeWindow.once('ready-to-show', () => {
    if (view) homeWindow.webContents.send('go-view', view);
    homeWindow.show();
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

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function createTray() {
  tray = new Tray(appIcon());
  tray.setToolTip('Timbre — portero Fermax');
  // Left click opens the flyout like the system tray icons do.
  tray.on('click', () => toggleFlyout());
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: haveCredentials() ? 'Timbre: a la escucha' : 'Timbre: sin configurar', enabled: false },
    { type: 'separator' },
    { label: 'Dispositivos', click: () => toggleFlyout() },
    { label: 'Ajustes', click: () => createHomeWindow('settings') },
    { label: 'Registro', click: () => createHomeWindow('log') },
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

function deviceById(deviceId) {
  return pairings.find((p) => p.deviceId === deviceId) || null;
}

function activeDevice() {
  const id = stores.settings.get('activeDeviceId');
  return pairings.find((p) => p.deviceId === id) || pairings[0] || null;
}

// Real camera count from the device's panel list, or 0 when still unknown.
function countCameras(deviceId) {
  const extra = deviceExtras.get(deviceId);
  return extra && extra.panels.length ? extra.panels.length : 0;
}

// Whether "switch camera" should be offered. True when the panel list shows
// more than one, or the account has the CHANGE_VIDEO_SOURCE service. Defaults
// to true when we could not read the extras, so a working feature isn't hidden.
function canSwitchCamera(deviceId) {
  const extra = deviceExtras.get(deviceId);
  if (!extra) return true;
  return !!extra.canSwitch;
}

// The doors a user can open on a device, for the UI.
function doorsOf(deviceId) {
  const p = deviceById(deviceId);
  if (!p) return [];
  return Object.values(p.accessDoors)
    .filter((d) => d.visible)
    .map((d) => ({ name: d.name, title: d.title }));
}

function notifyInfo(title, body, { urgent = false } = {}) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, urgency: urgent ? 'critical' : 'normal', silent: false });
  n.on('click', () => showFlyout());
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
    devices: pairings.map((p) => ({
      deviceId: p.deviceId,
      tag: p.tag,
      master: p.master,
      doors: doorsOf(p.deviceId),
      cameras: countCameras(p.deviceId),
      canSwitch: canSwitchCamera(p.deviceId),
    })),
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

ipcMain.handle('env:get', () => themeEnv());

function broadcastTheme() {
  const env = themeEnv();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send('theme', env);
      try {
        w.setBackgroundColor(isWin11 ? '#00000000' : env.dark ? '#202020' : '#f3f3f3');
      } catch {
        /* ignore */
      }
    }
  }
}

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
    if (info && info.roomId && info.deviceId) {
      await api.openDoorInCall({
        deviceId: info.deviceId,
        roomId: info.roomId,
        fcmToken: push?.fcmToken,
        callAs: info.callAs || info.deviceId,
      });
      return { ok: true };
    }
    return await openDoorDirect(info?.deviceId, info?.doorName);
  } catch (err) {
    return { error: err.message };
  }
});

// Open a door without a call in progress (from the device list).
async function openDoorDirect(deviceId, doorName) {
  const device = deviceId ? deviceById(deviceId) : activeDevice();
  if (!device) return { error: 'No hay ningún portero disponible' };
  const doors = Object.values(device.accessDoors);
  const door =
    (doorName && doors.find((d) => d.name === doorName)) ||
    doors.find((d) => d.visible) ||
    doors[0];
  if (!door) return { error: 'Este portero no tiene ninguna puerta' };
  await api.openDoor(device.deviceId, door.accessId, door.panelId);
  log(`Puerta abierta: ${door.title} (${device.tag || device.deviceId})`);
  return { ok: true };
}

ipcMain.handle('door:open', async (_e, { deviceId, doorName } = {}) => {
  try {
    return await openDoorDirect(deviceId, doorName);
  } catch (err) {
    return { error: err.message };
  }
});

// Ask a panel to start its camera so we can watch without anyone calling.
// The video arrives moments later via an Autoon push, which opens the window.
ipcMain.handle('camera:open', async (_e, { deviceId } = {}) => {
  try {
    const device = deviceId ? deviceById(deviceId) : activeDevice();
    if (!device) return { error: 'No hay ningún portero disponible' };
    if (!push?.fcmToken) return { error: 'Aún no hay conexión de avisos; espera unos segundos' };
    // The panel's video arrives via an Autoon push; keep the flyout pinned open.
    sessionActive = true;
    log(`Activando cámara: ${device.tag || device.deviceId}…`);
    const res = await api.autoOn(device.deviceId, push.fcmToken);
    if (!res) {
      sessionActive = false;
      return { error: 'El portero no respondió a tiempo' };
    }
    return { ok: true };
  } catch (err) {
    sessionActive = false;
    return { error: err.message };
  }
});

ipcMain.handle('camera:switch', async (_e, { deviceId } = {}) => {
  try {
    const device = deviceId ? deviceById(deviceId) : activeDevice();
    if (!device || !push?.fcmToken) return { error: 'No disponible' };
    await api.changeVideoSource(device.deviceId, push.fcmToken);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Open the full window on a given view (settings / log).
ipcMain.handle('main:open', (_e, view) => {
  createHomeWindow(view);
  return true;
});

// The flyout's call/camera session ended: let the flyout close on blur again.
ipcMain.on('flyout:ended', () => {
  sessionActive = false;
});

ipcMain.handle('call:log', (_e, line) => {
  log('[llamada] ' + line);
  return true;
});

// Dev/testing: simulate an incoming call without the cloud.
ipcMain.handle('debug:simulate-call', async () => {
  const device = activeDevice();
  await handleIncomingCall(
    {
      type: 'Call',
      deviceId: device?.deviceId || 'TEST-DEVICE',
      callAs: device?.deviceId || 'TEST-DEVICE',
      roomId: null,
      signalingUrl: stores.credentials.get('fermax')?.signalingUrl || '',
      title: 'Llamada de prueba',
      body: 'Simulación local (sin vídeo)',
      conversationTimeout: 90,
    },
    { mode: 'ring' }
  );
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.on('second-instance', () => toggleFlyout());

app.whenReady().then(async () => {
  stores = createStores(app.getPath('userData'));

  if (process.platform === 'win32') app.setAppUserModelId('com.ignacioaranda.timbre');

  // Follow the OS light/dark setting and react when it changes.
  nativeTheme.themeSource = 'system';
  nativeTheme.on('updated', () => broadcastTheme());

  // Autostart on login (Windows/Linux).
  app.setLoginItemSettings({ openAtLogin: !!stores.settings.get('autostart'), openAsHidden: true });

  createTray();
  createFlyout(); // ready, hidden, behind the tray icon

  // First run: open the full window on setup. Otherwise live in the tray.
  if (!haveCredentials()) {
    createHomeWindow('settings');
  }

  // In a render smoke test we don't touch the network.
  if (haveCredentials() && !process.env.TIMBRE_SMOKE) {
    await startServices();
  }

  app.on('activate', () => toggleFlyout());

  // Smoke test hook: prove the full main process boots and windows render,
  // then exit. Never used in normal runs.
  if (process.env.TIMBRE_SMOKE) {
    const marker = path.isAbsolute(process.env.TIMBRE_SMOKE)
      ? process.env.TIMBRE_SMOKE
      : path.join(app.getPath('temp'), process.env.TIMBRE_SMOKE);
    const win = flyoutWindow || homeWindow;
    const ok = {
      flyout: !!flyoutWindow,
      tray: !!tray,
      configured: haveCredentials(),
      windows: BrowserWindow.getAllWindows().length,
    };
    const checkRender = () => {
      win.webContents
        .executeJavaScript('!!document.querySelector(".fly-brand, .brand")')
        .then((rendererOk) => {
          fs.writeFileSync(marker, JSON.stringify({ ...ok, rendererOk }, null, 2));
          setTimeout(() => app.exit(0), 300);
        })
        .catch((err) => {
          fs.writeFileSync(marker, JSON.stringify({ ...ok, rendererError: err.message }, null, 2));
          setTimeout(() => app.exit(1), 300);
        });
    };
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', checkRender);
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
