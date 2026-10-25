// Call window: shows the visitor, plays the ring through the PC's own output
// (so it reaches your headphones even when the phone is on silent), and runs the
// mediasoup WebRTC session for video, listening and talk-back.

import { Device } from 'mediasoup-client';
import { Signaling } from './signaling.js';

const api = window.timbre;

const el = (id) => document.getElementById(id);
const ui = {
  title: el('title'),
  subtitle: el('subtitle'),
  photo: el('photo'),
  video: el('video'),
  status: el('status'),
  answer: el('btn-answer'),
  open: el('btn-open'),
  hangup: el('btn-hangup'),
  mute: el('btn-mute'),
};

let ring = null;
let current = null; // { info, signaling, device, recvVideo, recvAudio, send, ... }
let hangupTimer = null;

function log(msg) {
  api.callLog(msg);
}

function setStatus(text) {
  ui.status.textContent = text;
}

// --- Ring sound -----------------------------------------------------------

function startRing(settings) {
  stopRing();
  // The bundled ring is a WAV asset; HTML audio plays to the default output
  // device. Desktop OSes don't mute app audio for "silent mode", which is the
  // whole point: a call reaches your headphones regardless of the phone.
  ring = new Audio('../../assets/ring.wav');
  ring.loop = true;
  ring.volume = Math.min(1, Math.max(0, settings.ringVolume ?? 0.9));
  ring.play().catch((err) => log('No se pudo reproducir el tono: ' + err.message));
}

function stopRing() {
  if (ring) {
    ring.pause();
    ring.currentTime = 0;
    ring = null;
  }
}

// --- Incoming call --------------------------------------------------------

api.onIncomingCall(async (info) => {
  resetSession('new-call');
  current = { info, answered: false, muted: false };

  ui.title.textContent = info.title || 'Llamada del portero';
  ui.subtitle.textContent = info.deviceName || '';
  if (info.photoDataUrl) {
    ui.photo.src = info.photoDataUrl;
    ui.photo.classList.remove('hidden');
  } else {
    ui.photo.classList.add('hidden');
  }
  ui.video.classList.add('hidden');
  ui.answer.disabled = false;
  ui.open.disabled = false;
  ui.mute.classList.add('hidden');
  setStatus('Llamando…');

  startRing(info.settings || {});

  // Auto-hangup when the conversation window would expire server-side.
  const ttl = (info.conversationTimeout || 90) + 15;
  hangupTimer = setTimeout(() => endSession('timeout'), ttl * 1000);

  // Start the video preview if we have a room and it's enabled.
  if (info.roomId && info.signalingUrl && (info.settings?.showVideo ?? true)) {
    try {
      await startMedia(info, { receiveOnly: true });
      setStatus('Vídeo en directo — pulsa Contestar para hablar');
    } catch (err) {
      log('Vídeo no disponible: ' + err.message);
      setStatus('Llamando… (sin vídeo: ' + err.message + ')');
    }
  } else if (!info.roomId) {
    setStatus('Llamando… (prueba local sin vídeo)');
  }
});

api.onCallEnded(() => endSession('remote'));

// --- Media (mediasoup) ----------------------------------------------------

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

  // Receive video.
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

  const videoConsume = await signaling.consume(
    recvVideo.id,
    room.producerIdVideo,
    device.rtpCapabilities
  );
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
  ui.video.classList.remove('hidden');
  ui.photo.classList.add('hidden');
  await ui.video.play().catch(() => {});

  // Prepare the audio receive transport (used once we pick up).
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
    // No media session yet (e.g. simulated call): nothing to answer.
    current.answered = true;
    return;
  }

  signaling.sendHangup = true;

  // Our mic -> send transport -> produce; the pickup ACK carries the panel's
  // audio producer id, which we then consume.
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
        const audioConsume = await signaling.consume(
          current.recvAudio.id,
          remoteAudioId,
          device.rtpCapabilities
        );
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
  const micTrack = micStream.getAudioTracks()[0];
  current.audioProducer = await send.produce({ track: micTrack, stopTracks: false });

  current.answered = true;
  ui.answer.disabled = true;
  ui.mute.classList.remove('hidden');
  setStatus('En conversación');
  stopRing();
}

// --- Buttons --------------------------------------------------------------

ui.answer.addEventListener('click', async () => {
  stopRing();
  setStatus('Conectando audio…');
  try {
    if (!current.signaling && current.info.roomId) {
      await startMedia(current.info, { receiveOnly: false });
    } else {
      await answerInternal();
    }
  } catch (err) {
    log('Error al contestar: ' + err.message);
    setStatus('No se pudo contestar: ' + err.message);
  }
});

ui.open.addEventListener('click', async () => {
  ui.open.disabled = true;
  setStatus('Abriendo la puerta…');
  const res = await api.openDoor({
    deviceId: current.info.deviceId,
    callAs: current.info.callAs,
    roomId: current.info.roomId,
  });
  if (res.ok) {
    setStatus('Puerta abierta ✓');
  } else {
    setStatus('No se pudo abrir: ' + (res.error || 'error'));
    ui.open.disabled = false;
  }
});

ui.mute.addEventListener('click', () => {
  if (!current?.audioProducer) return;
  current.muted = !current.muted;
  current.micStream?.getAudioTracks().forEach((t) => (t.enabled = !current.muted));
  ui.mute.textContent = current.muted ? 'Activar micrófono' : 'Silenciar';
});

ui.hangup.addEventListener('click', () => endSession('user'));

// --- Teardown -------------------------------------------------------------

function resetSession(reason) {
  if (current) teardownMedia();
  stopRing();
  clearTimeout(hangupTimer);
  hangupTimer = null;
  log('reset (' + reason + ')');
}

function teardownMedia() {
  try {
    current.micStream?.getTracks().forEach((t) => t.stop());
  } catch {
    /* ignore */
  }
  try {
    current.audioProducer?.close();
    current.videoConsumer?.close();
    current.audioConsumer?.close();
    current.recvVideo?.close();
    current.recvAudio?.close();
    current.send?.close();
  } catch {
    /* ignore */
  }
  try {
    current.signaling?.disconnect();
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
  setStatus(reason === 'user' ? 'Llamada finalizada' : reason === 'timeout' ? 'Llamada expirada' : 'Llamada finalizada');
  ui.answer.disabled = true;
  ui.open.disabled = true;
  ui.mute.classList.add('hidden');
  setTimeout(() => api.hideCall(), 800);
}

setStatus('Listo');
