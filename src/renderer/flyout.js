// Tray flyout: the day-to-day surface. Lists devices, opens the camera and the
// call inline (mediasoup), and opens the full window only for Settings/Log.

import { Device } from 'mediasoup-client';
import { Signaling } from './signaling.js';

const api = window.timbre || demoFlyoutApi();
const el = (id) => document.getElementById(id);
const show = (node, on) => node.classList.toggle('hidden', !on);
const icon = (id) => `<svg class="ico"><use href="#${id}" /></svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const log = (m) => api.callLog?.(m);

let state = null;
let current = null; // active camera/call session
let ring = null;
let hangupTimer = null;

// ---- Native env ----------------------------------------------------------

function applyEnv(env) {
  if (!env) return;
  document.body.classList.toggle('is-win', env.platform === 'win32');
  document.body.classList.toggle('is-linux', env.platform === 'linux');
  document.body.classList.toggle('mica', !!env.isWin11);
  if (env.accent) {
    const n = parseInt(env.accent.replace('#', ''), 16);
    const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    document.documentElement.style.setProperty('--accent', env.accent);
    document.documentElement.style.setProperty('--on-accent', lum > 0.6 ? '#1a1a1a' : '#ffffff');
  }
}

// ---- Views ---------------------------------------------------------------

function showDevices() {
  show(el('fly-camera'), false);
  show(el('fly-devices'), true);
}
function showCamera() {
  show(el('fly-devices'), false);
  show(el('fly-camera'), true);
}

// ---- State / device list -------------------------------------------------

function renderStatus() {
  const s = el('fly-status');
  s.classList.remove('is-on', 'is-off');
  if (state.configured && state.fcmActive) {
    s.classList.add('is-on');
    s.lastChild.textContent = 'A la escucha';
  } else if (state.configured) {
    s.lastChild.textContent = 'Conectando…';
  } else {
    s.classList.add('is-off');
    s.lastChild.textContent = 'Sin configurar';
  }
}

function renderDevices() {
  const empty = el('fly-empty');
  const list = el('fly-list');
  if (!state.configured) {
    show(empty, true);
    list.innerHTML = '';
    return;
  }
  show(empty, false);
  const online = state.fcmActive;
  list.innerHTML = (state.devices || [])
    .map((d) => {
      const name = d.tag || 'Portero';
      const doors = d.doors && d.doors.length ? d.doors : [{ name: null, title: 'puerta' }];
      const doorBtns = doors
        .map(
          (dr) =>
            `<button class="btn btn--subtle" data-door="${esc(d.deviceId)}" data-door-name="${esc(dr.name || '')}">${icon('i-key')}Abrir ${esc(doors.length > 1 ? dr.title : 'puerta')}</button>`
        )
        .join('');
      const cams = d.cameras > 1 ? `${d.cameras} cámaras` : d.canSwitch ? 'Varias cámaras' : '1 cámara';
      return `
        <div class="fly-device">
          <div class="fly-device__top">
            <span class="fly-device__icon">${icon('i-camera')}</span>
            <div>
              <div class="fly-device__name">${esc(name)}</div>
              <div class="fly-device__status ${online ? '' : 'is-off'}"><span class="dot"></span>${online ? 'Disponible' : 'Sin conexión'} · ${cams}</div>
            </div>
          </div>
          <div class="fly-device__actions">
            <button class="btn btn--accent" data-camera="${esc(d.deviceId)}" data-name="${esc(name)}">${icon('i-camera')}Ver cámara</button>
            ${doorBtns}
          </div>
        </div>`;
    })
    .join('');
}

function render() {
  if (!state) return;
  renderStatus();
  if (!current) renderDevices();
}

// ---- Clicks --------------------------------------------------------------

document.addEventListener('click', async (e) => {
  const cam = e.target.closest('[data-camera]');
  if (cam) return openCameraFor(cam.dataset.camera, cam.dataset.name);
  const door = e.target.closest('[data-door]');
  if (door) {
    door.disabled = true;
    const res = await api.openDoorDevice(door.dataset.door, door.dataset.doorName || undefined);
    flash(door, res?.ok ? 'Abierta' : 'Error');
    door.disabled = false;
  }
});

function flash(btn, text) {
  const prev = btn.innerHTML;
  btn.textContent = text;
  setTimeout(() => (btn.innerHTML = prev), 1400);
}

el('fly-settings').addEventListener('click', () => api.openMain('settings'));
el('fly-log').addEventListener('click', () => api.openMain('log'));
el('fly-setup').addEventListener('click', () => api.openMain('settings'));
el('fly-back').addEventListener('click', () => endSession('user'));
el('fly-hangup').addEventListener('click', () => endSession('user'));

el('fly-open').addEventListener('click', async () => {
  el('fly-open').disabled = true;
  setCamStatus('Abriendo la puerta…');
  const res = await api.openDoor({ deviceId: current?.info.deviceId, callAs: current?.info.callAs, roomId: current?.info.roomId });
  setCamStatus(res.ok ? 'Puerta abierta' : 'No se pudo abrir: ' + (res.error || 'error'));
  if (!res.ok) el('fly-open').disabled = false;
});
el('fly-answer').addEventListener('click', doAnswer);
el('fly-switch').addEventListener('click', async () => {
  el('fly-switch').disabled = true;
  freezeFrame();
  setCamStatus('Cambiando de cámara…');
  const res = await api.switchCamera(current?.info.deviceId);
  if (res?.error) setCamStatus('No se pudo cambiar: ' + res.error);
  setTimeout(() => (el('fly-switch').disabled = false), 1500);
});

// Freeze the current video frame into the still image, so a reconnect (camera
// switch) shows the last picture with a "changing…" label instead of going black.
function freezeFrame() {
  const v = el('fly-video');
  if (!v.videoWidth) return false;
  try {
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    el('fly-photo').src = c.toDataURL('image/jpeg', 0.82);
    show(el('fly-photo'), true);
    show(el('fly-video'), false);
    show(el('fly-ph'), false);
    return true;
  } catch {
    return false;
  }
}

// ---- Open camera on demand ----------------------------------------------

async function openCameraFor(deviceId, name) {
  current = { info: { deviceId, deviceName: name, mode: 'camera' }, answered: false, pending: true, retries: 0 };
  prepareCameraView('camera', name || 'Cámara');
  setCamStatus('Activando cámara…');
  const res = await api.openCamera(deviceId);
  if (res?.error) setCamStatus(res.error);
}

// A join can fail because the panel's room expired between the push and our
// join. That's transient: ask for the camera again rather than showing an error.
const MAX_CAM_RETRIES = 2;
function isTransientJoin(err) {
  const m = (err && err.message) || '';
  return /room|finished|exist|timeout|join_call/i.test(m);
}
async function retryCamera(deviceId) {
  const n = (current?.retries || 0) + 1;
  current = { info: { deviceId, mode: 'camera' }, answered: false, pending: true, retries: n };
  setCamStatus('Activando cámara…');
  const res = await api.openCamera(deviceId);
  if (res?.error) setCamStatus(res.error);
}

function prepareCameraView(mode, title) {
  showCamera();
  el('fly-eyebrow').textContent = mode === 'camera' ? 'Cámara en directo' : 'Llamando';
  el('fly-title').textContent = title;
  el('fly-hangup-label').textContent = mode === 'camera' ? 'Cerrar' : 'Colgar';
  show(el('fly-answer'), mode !== 'camera');
  show(el('fly-switch'), false);
  show(el('fly-photo'), false);
  show(el('fly-video'), false);
  show(el('fly-ph'), true);
  // During an incoming call, "Contestar" is the single coloured primary, so
  // "Abrir" stays neutral; when it's an on-demand camera (no call), "Abrir" is
  // the main action and takes the accent.
  el('fly-open').classList.toggle('btn--accent', mode === 'camera');
  el('fly-open').disabled = false;
}

// ---- Incoming (ring or camera) from main --------------------------------

api.onIncomingCall(async (info) => {
  await startCall(info);
});
api.onSwitchRoom(async (info) => {
  const wasAnswered = current?.answered;
  freezeFrame(); // keep the last picture while we reconnect
  teardownMedia({ hangup: false }); // switching rooms, not ending the session
  current = { info, answered: false };
  setCamStatus('Cambiando de cámara…');
  try {
    await startMedia(info, { receiveOnly: !wasAnswered });
    setCamStatus('Cámara en directo');
  } catch (err) {
    log('Cambio de cámara falló: ' + err.message);
    setCamStatus('No se pudo cambiar de cámara');
  }
});
api.onCallEnded(() => endSession('remote'));

async function startCall(info) {
  // Keep any pending openCamera session info, but prefer the push's room data.
  const retries = current?.retries || 0;
  current = { info, answered: false, muted: false, retries };
  const isRing = info.mode !== 'camera';
  prepareCameraView(isRing ? 'ring' : 'camera', info.title || info.deviceName || 'Portero');
  show(el('fly-switch'), !isRing && !!info.canSwitchCamera);
  document.body.classList.toggle('is-ringing', isRing);

  if (info.photoDataUrl) {
    el('fly-photo').src = info.photoDataUrl;
    show(el('fly-photo'), true);
    show(el('fly-ph'), false);
  }

  if (isRing) {
    startRing(info.settings);
    setCamStatus('Pulsa Contestar para hablar');
  } else {
    setCamStatus('Conectando con la cámara…');
  }

  const ttl = (info.conversationTimeout || 90) + 15;
  clearTimeout(hangupTimer);
  hangupTimer = setTimeout(() => endSession('timeout'), ttl * 1000);

  if (info.roomId && info.signalingUrl) {
    try {
      await startMedia(info, { receiveOnly: true });
      setCamStatus(isRing ? 'En directo — Contestar para hablar' : 'Cámara en directo');
    } catch (err) {
      log('Vídeo no disponible: ' + err.message);
      // Transient room expiry: quietly ask the panel to wake again.
      if (!isRing && isTransientJoin(err) && retries < MAX_CAM_RETRIES) {
        teardownMedia({ hangup: false }); // retrying the join, not ending it
        return retryCamera(info.deviceId);
      }
      setCamStatus(isRing ? 'No se pudo conectar la llamada' : 'No se pudo abrir la cámara. Prueba otra vez.');
    }
  }
}

// ---- Ring sound ----------------------------------------------------------

function startRing(settings) {
  stopRing();
  ring = new Audio('../../assets/ring.wav');
  ring.loop = true;
  ring.volume = Math.min(1, Math.max(0, settings?.ringVolume ?? 0.9));
  ring.play().catch(() => {});
}
function stopRing() {
  if (ring) {
    ring.pause();
    ring = null;
  }
}

// ---- mediasoup -----------------------------------------------------------

async function startMedia(info, { receiveOnly }) {
  const signaling = new Signaling({
    url: info.signalingUrl,
    roomId: info.roomId,
    oauthToken: info.oauthToken,
    fcmToken: info.fcmToken,
    onEndUp: () => endSession('remote'),
    onLog: (m) => log(m),
  });
  current.signaling = signaling;
  // An on-demand camera is a session we own and must release on close; a ring we
  // haven't answered belongs to the visitor, so we leave it be. (Answering a
  // ring sets this true too, in answerInternal.)
  signaling.sendHangup = info.mode === 'camera';
  const room = await signaling.connect();

  const device = new Device();
  await device.load({ routerRtpCapabilities: room.routerRtpCapabilities });
  current.device = device;
  current.room = room;
  const iceServers = room.iceServers || [];

  const recvVideo = device.createRecvTransport({
    id: room.recvTransportVideo.id,
    iceParameters: room.recvTransportVideo.iceParameters,
    iceCandidates: room.recvTransportVideo.iceCandidates,
    dtlsParameters: room.recvTransportVideo.dtlsParameters,
    iceServers,
  });
  current.recvVideo = recvVideo;
  recvVideo.on('connect', ({ dtlsParameters }, cb, errback) => {
    signaling.connectTransport(recvVideo.id, dtlsParameters).then(cb).catch(errback);
  });

  const vc = await signaling.consume(recvVideo.id, room.producerIdVideo, device.rtpCapabilities);
  const videoConsumer = await recvVideo.consume({ id: vc.id, producerId: vc.producerId, kind: vc.kind, rtpParameters: vc.rtpParameters });
  current.videoConsumer = videoConsumer;

  const stream = new MediaStream([videoConsumer.track]);
  current.stream = stream;
  el('fly-video').srcObject = stream;
  show(el('fly-video'), true);
  show(el('fly-photo'), false);
  show(el('fly-ph'), false);
  document.body.classList.remove('is-ringing');
  await el('fly-video').play().catch(() => {});

  if (room.recvTransportAudio && room.producerIdAudio) {
    const recvAudio = device.createRecvTransport({
      id: room.recvTransportAudio.id,
      iceParameters: room.recvTransportAudio.iceParameters,
      iceCandidates: room.recvTransportAudio.iceCandidates,
      dtlsParameters: room.recvTransportAudio.dtlsParameters,
      iceServers,
    });
    current.recvAudio = recvAudio;
    recvAudio.on('connect', ({ dtlsParameters }, cb, errback) => {
      signaling.connectTransport(recvAudio.id, dtlsParameters).then(cb).catch(errback);
    });
  }

  if (!receiveOnly) await answerInternal();
}

async function answerInternal() {
  if (!current || current.answered) return;
  const { signaling, device, room } = current;
  if (!signaling || !device) {
    current.answered = true;
    return;
  }
  signaling.sendHangup = true;
  const send = device.createSendTransport({
    id: room.sendTransport.id,
    iceParameters: room.sendTransport.iceParameters,
    iceCandidates: room.sendTransport.iceCandidates,
    dtlsParameters: room.sendTransport.dtlsParameters,
    iceServers: room.iceServers || [],
  });
  current.send = send;
  send.on('connect', ({ dtlsParameters }, cb, errback) => {
    signaling.connectTransport(send.id, dtlsParameters).then(cb).catch(errback);
  });
  send.on('produce', async ({ kind, rtpParameters, appData }, cb, errback) => {
    try {
      const result = await signaling.pickup({ kind, rtpParameters, appData, rtpCapabilities: device.rtpCapabilities });
      cb({ id: result.producerId });
      const remoteAudioId = result.consumer?.producerId;
      if (remoteAudioId && current.recvAudio) {
        const ac = await signaling.consume(current.recvAudio.id, remoteAudioId, device.rtpCapabilities);
        const audioConsumer = await current.recvAudio.consume({ id: ac.id, producerId: ac.producerId, kind: ac.kind, rtpParameters: ac.rtpParameters });
        current.audioConsumer = audioConsumer;
        current.stream.addTrack(audioConsumer.track);
        el('fly-video').srcObject = current.stream;
      }
    } catch (err) {
      errback(err);
    }
  });
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  current.micStream = mic;
  current.audioProducer = await send.produce({ track: mic.getAudioTracks()[0], stopTracks: false });
  current.answered = true;
  show(el('fly-answer'), false);
  setCamStatus('En conversación');
  stopRing();
}

async function doAnswer() {
  stopRing();
  setCamStatus('Conectando audio…');
  try {
    if (!current.signaling && current.info.roomId) await startMedia(current.info, { receiveOnly: false });
    else await answerInternal();
  } catch (err) {
    setCamStatus('No se pudo contestar: ' + err.message);
  }
}

// ---- Teardown ------------------------------------------------------------

function teardownMedia({ hangup = true } = {}) {
  try {
    current?.micStream?.getTracks().forEach((t) => t.stop());
    current?.audioProducer?.close();
    current?.videoConsumer?.close();
    current?.audioConsumer?.close();
    current?.recvVideo?.close();
    current?.recvAudio?.close();
    current?.send?.close();
    if (current?.signaling) {
      // When we're only switching cameras (or retrying a failed join) we keep
      // the overall session alive, so suppress the hang_up that would tell the
      // panel to tear it down.
      if (!hangup) current.signaling.sendHangup = false;
      current.signaling.disconnect();
    }
  } catch {
    /* ignore */
  }
  el('fly-video').srcObject = null;
}

function endSession() {
  stopRing();
  clearTimeout(hangupTimer);
  hangupTimer = null;
  if (current) {
    teardownMedia();
    current = null;
  }
  document.body.classList.remove('is-ringing');
  api.callEnded?.();
  showDevices();
  render();
}

function setCamStatus(t) {
  el('fly-cam-status').textContent = t;
}

// ---- Boot ----------------------------------------------------------------

api.getEnv?.().then(applyEnv);
api.onTheme?.(applyEnv);
api.onState((s) => {
  state = s;
  render();
});
api.requestState();

// Browser-preview fallback so the panel can be reviewed without Electron.
function demoFlyoutApi() {
  const st = {
    configured: true,
    fcmActive: true,
    devices: [
      { deviceId: 'A', tag: 'Casa', master: true, cameras: 2, doors: [{ name: 'g', title: 'Portal' }, { name: 'z', title: 'Garaje' }] },
    ],
  };
  return {
    onState: (cb) => setTimeout(() => cb(st), 0),
    requestState: () => {},
    getEnv: async () => ({ platform: 'win32', isWin11: false, accent: '#8a5cf6', dark: matchMedia('(prefers-color-scheme: dark)').matches }),
    onTheme: () => {},
    onIncomingCall: () => {},
    onSwitchRoom: () => {},
    onCallEnded: () => {},
    openCamera: async () => ({ ok: true }),
    openDoor: async () => ({ ok: true }),
    openDoorDevice: async () => ({ ok: true }),
    switchCamera: async () => ({ ok: true }),
    openMain: () => {},
    callEnded: () => {},
    callLog: () => {},
  };
}
