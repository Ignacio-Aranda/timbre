// Call window: shows the visitor or the live camera, plays the ring through the
// PC's own output (so it reaches your headphones even with the phone on silent),
// and runs the mediasoup WebRTC session for video, listening and talk-back.
//
// Two modes:
//   ring   — someone pressed the doorbell: ring sound + Answer.
//   camera — we opened the camera on demand (auto-on): no ring, Talk + Switch.

import { Device } from 'mediasoup-client';
import { Signaling } from './signaling.js';

const api = window.timbre;
const el = (id) => document.getElementById(id);
const ui = {
  body: document.body,
  eyebrow: el('eyebrow'),
  title: el('title'),
  subtitle: el('subtitle'),
  photo: el('photo'),
  video: el('video'),
  placeholder: el('placeholder'),
  status: el('status'),
  open: el('btn-open'),
  answer: el('btn-answer'),
  talk: el('btn-talk'),
  switch: el('btn-switch'),
  hangup: el('btn-hangup'),
  hangupLabel: el('hangup-label'),
  mute: el('btn-mute'),
};

let ring = null;
let current = null;
let hangupTimer = null;

const log = (m) => api.callLog(m);
const setStatus = (t) => (ui.status.textContent = t);

// Native environment: platform class + OS accent colour.
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
api.getEnv?.().then(applyEnv);
api.onTheme?.(applyEnv);

// ---- Ring sound ----------------------------------------------------------

function startRing(settings) {
  stopRing();
  ring = new Audio('../../assets/ring.wav');
  ring.loop = true;
  ring.volume = Math.min(1, Math.max(0, settings?.ringVolume ?? 0.9));
  ring.play().catch((err) => log('No se pudo reproducir el tono: ' + err.message));
}
function stopRing() {
  if (ring) {
    ring.pause();
    ring = null;
  }
}

// ---- Incoming call / camera ---------------------------------------------

api.onIncomingCall(async (info) => {
  resetSession('new');
  current = { info, answered: false, muted: false };

  const isRing = info.mode !== 'camera';
  ui.eyebrow.textContent = isRing ? 'Llamando' : 'Cámara en directo';
  ui.title.textContent = info.title || (isRing ? 'Portero' : info.deviceName || 'Cámara');
  ui.subtitle.textContent = isRing ? info.deviceName || '' : '';
  ui.hangupLabel.textContent = isRing ? 'Colgar' : 'Cerrar';

  // Buttons per mode.
  show(ui.answer, isRing);
  show(ui.talk, !isRing);
  show(ui.switch, !isRing && !!info.canSwitchCamera);
  show(ui.mute, false);
  ui.open.disabled = false;
  ui.answer.disabled = false;

  // Visitor photo (ring only).
  if (info.photoDataUrl) {
    ui.photo.src = info.photoDataUrl;
    show(ui.photo, true);
    show(ui.placeholder, false);
  } else {
    show(ui.photo, false);
    show(ui.placeholder, true);
  }
  show(ui.video, false);

  ui.body.classList.toggle('is-ringing', isRing);

  if (isRing) {
    startRing(info.settings);
    setStatus('Pulsa Contestar para hablar');
  } else {
    setStatus('Conectando con la cámara…');
  }

  const ttl = (info.conversationTimeout || 90) + 15;
  hangupTimer = setTimeout(() => endSession('timeout'), ttl * 1000);

  const showVideo = info.mode === 'camera' || (info.settings?.showVideo ?? true);
  if (info.roomId && info.signalingUrl && showVideo) {
    try {
      await startMedia(info, { receiveOnly: true });
      setStatus(isRing ? 'Vídeo en directo — Contestar para hablar' : 'Cámara en directo');
    } catch (err) {
      log('Vídeo no disponible: ' + err.message);
      setStatus('Sin vídeo: ' + err.message);
    }
  } else if (!info.roomId) {
    setStatus(isRing ? 'Llamando… (prueba local, sin vídeo)' : 'Sin sala de vídeo');
  }
});

api.onCallEnded(() => endSession('remote'));

// The panel moved us to another camera: re-join the new room in place.
api.onSwitchRoom(async (info) => {
  const wasAnswered = current?.answered;
  teardownMedia();
  current = { info, answered: false, muted: false };
  ui.title.textContent = info.title || info.deviceName || 'Cámara';
  show(ui.switch, !!info.canSwitchCamera);
  setStatus('Cambiando de cámara…');
  try {
    await startMedia(info, { receiveOnly: !wasAnswered });
    setStatus('Cámara en directo');
  } catch (err) {
    setStatus('No se pudo cambiar de cámara: ' + err.message);
  }
});

// ---- Media (mediasoup) ---------------------------------------------------

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

  const room = await signaling.connect();
  log('sala unida: video=' + room.producerIdVideo + ' audio=' + room.producerIdAudio);

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

  const videoConsume = await signaling.consume(recvVideo.id, room.producerIdVideo, device.rtpCapabilities);
  const videoConsumer = await recvVideo.consume({
    id: videoConsume.id,
    producerId: videoConsume.producerId,
    kind: videoConsume.kind,
    rtpParameters: videoConsume.rtpParameters,
  });
  current.videoConsumer = videoConsumer;

  const stream = new MediaStream([videoConsumer.track]);
  current.stream = stream;
  ui.video.srcObject = stream;
  show(ui.video, true);
  show(ui.photo, false);
  show(ui.placeholder, false);
  ui.body.classList.remove('is-ringing');
  await ui.video.play().catch(() => {});

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
      const result = await signaling.pickup({
        kind,
        rtpParameters,
        appData,
        rtpCapabilities: device.rtpCapabilities,
      });
      cb({ id: result.producerId });
      const remoteAudioId = result.consumer?.producerId;
      if (remoteAudioId && current.recvAudio) {
        const audioConsume = await signaling.consume(current.recvAudio.id, remoteAudioId, device.rtpCapabilities);
        const audioConsumer = await current.recvAudio.consume({
          id: audioConsume.id,
          producerId: audioConsume.producerId,
          kind: audioConsume.kind,
          rtpParameters: audioConsume.rtpParameters,
        });
        current.audioConsumer = audioConsumer;
        current.stream.addTrack(audioConsumer.track);
        ui.video.srcObject = current.stream;
      }
    } catch (err) {
      errback(err);
    }
  });

  const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  current.micStream = micStream;
  current.audioProducer = await send.produce({ track: micStream.getAudioTracks()[0], stopTracks: false });

  current.answered = true;
  show(ui.answer, false);
  show(ui.talk, false);
  show(ui.mute, true);
  setStatus('En conversación');
  stopRing();
}

// ---- Buttons -------------------------------------------------------------

async function doAnswer() {
  stopRing();
  setStatus('Conectando audio…');
  try {
    if (!current.signaling && current.info.roomId) await startMedia(current.info, { receiveOnly: false });
    else await answerInternal();
  } catch (err) {
    log('Error al contestar: ' + err.message);
    setStatus('No se pudo contestar: ' + err.message);
  }
}
ui.answer.addEventListener('click', doAnswer);
ui.talk.addEventListener('click', doAnswer);

ui.open.addEventListener('click', async () => {
  ui.open.disabled = true;
  setStatus('Abriendo la puerta…');
  const res = await api.openDoor({
    deviceId: current.info.deviceId,
    callAs: current.info.callAs,
    roomId: current.info.roomId,
  });
  setStatus(res.ok ? 'Puerta abierta' : 'No se pudo abrir: ' + (res.error || 'error'));
  if (!res.ok) ui.open.disabled = false;
});

ui.switch.addEventListener('click', async () => {
  ui.switch.disabled = true;
  setStatus('Cambiando de cámara…');
  const res = await api.switchCamera(current.info.deviceId);
  if (res?.error) {
    setStatus('No se pudo cambiar: ' + res.error);
  }
  setTimeout(() => (ui.switch.disabled = false), 1500);
});

ui.mute.addEventListener('click', () => {
  if (!current?.audioProducer) return;
  current.muted = !current.muted;
  current.micStream?.getAudioTracks().forEach((t) => (t.enabled = !current.muted));
  ui.mute.textContent = current.muted ? 'Activar micrófono' : 'Silenciar micrófono';
});

ui.hangup.addEventListener('click', () => endSession('user'));

// ---- Teardown ------------------------------------------------------------

function resetSession(reason) {
  if (current) teardownMedia();
  stopRing();
  clearTimeout(hangupTimer);
  hangupTimer = null;
  log('reset (' + reason + ')');
}

function teardownMedia() {
  try {
    current?.micStream?.getTracks().forEach((t) => t.stop());
    current?.audioProducer?.close();
    current?.videoConsumer?.close();
    current?.audioConsumer?.close();
    current?.recvVideo?.close();
    current?.recvAudio?.close();
    current?.send?.close();
    current?.signaling?.disconnect();
  } catch {
    /* ignore */
  }
  ui.video.srcObject = null;
}

function endSession(reason) {
  stopRing();
  clearTimeout(hangupTimer);
  hangupTimer = null;
  if (current) {
    teardownMedia();
    current = null;
  }
  ui.body.classList.remove('is-ringing');
  setStatus(reason === 'timeout' ? 'Finalizada por tiempo' : 'Llamada finalizada');
  ui.open.disabled = true;
  ui.answer.disabled = true;
  show(ui.mute, false);
  show(ui.talk, false);
  show(ui.switch, false);
  setTimeout(() => api.hideCall(), 700);
}

function show(node, on) {
  node.classList.toggle('hidden', !on);
}

setStatus('');
