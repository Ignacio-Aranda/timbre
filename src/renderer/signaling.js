// Socket.IO signaling for Fermax mediasoup calls.
//
// Mirrors the Android app's SocketIOClient / MediasoupManager: it joins a room
// with the FCM app token and the OAuth token, then exchanges mediasoup
// transport/consumer/producer messages. Event names and payload shapes are
// taken from the app and confirmed against the Home Assistant integration.

import { io } from 'socket.io-client';

const PROTOCOL_VERSION = '0.8.2';
const ACK_TIMEOUT_MS = 15000;

export class Signaling {
  constructor({ url, roomId, oauthToken, fcmToken, onEndUp, onLog }) {
    this.url = url;
    this.roomId = roomId;
    this.oauthToken = oauthToken || '';
    this.fcmToken = fcmToken || '';
    this.onEndUp = onEndUp || (() => {});
    this.onLog = onLog || (() => {});
    this.socket = null;
    this.sendHangup = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = io(this.url, {
        transports: ['websocket'],
        reconnection: false,
        timeout: ACK_TIMEOUT_MS,
        forceNew: true,
      });

      this.socket.on('connect', () => this.onLog('socket conectado'));
      this.socket.on('connect_error', (err) => {
        this.onLog('error de conexión: ' + err.message);
        reject(new Error('No se pudo conectar al servidor de señalización: ' + err.message));
      });
      this.socket.on('disconnect', (reason) => this.onLog('socket desconectado: ' + reason));
      this.socket.on('error', (data) => this.onLog('error de señalización: ' + JSON.stringify(data)));
      this.socket.on('end_up', (data) => {
        const code = data && typeof data === 'object' ? data.code : String(data);
        this.onLog('end_up: ' + code);
        this.onEndUp(code);
      });

      this.socket.once('connect', async () => {
        try {
          const res = await this._call('join_call', {
            roomId: this.roomId,
            appToken: this.fcmToken,
            fermaxOauthToken: this.oauthToken,
            protocolVersion: PROTOCOL_VERSION,
          });
          if (!res || res.error) {
            return reject(new Error('join_call falló: ' + JSON.stringify(res)));
          }
          resolve(res.result || res);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  _call(event, payload) {
    return this.socket.timeout(ACK_TIMEOUT_MS).emitWithAck(event, payload);
  }

  async consume(transportId, producerId, rtpCapabilities) {
    const res = await this._call('transport_consume', {
      transportId,
      producerId,
      rtpCapabilities,
    });
    if (!res || res.error) throw new Error('transport_consume: ' + JSON.stringify(res));
    return res.result;
  }

  async connectTransport(transportId, dtlsParameters) {
    const res = await this._call('transport_connect', { transportId, dtlsParameters });
    if (res && res.error) throw new Error('transport_connect: ' + JSON.stringify(res));
    return true;
  }

  // Answer the call: register our audio producer and get the panel audio id back.
  async pickup({ kind, rtpParameters, appData, rtpCapabilities }) {
    const res = await this._call('pickup', {
      parameters: { kind, rtpParameters, appData: appData || {} },
      rtpCapabilities,
    });
    if (!res || res.error) throw new Error('pickup: ' + JSON.stringify(res));
    return res.result;
  }

  disconnect() {
    if (!this.socket) return;
    const sock = this.socket;
    this.socket = null;
    const close = () => {
      try {
        sock.disconnect();
      } catch {
        /* ignore */
      }
    };
    // A ring we never answered leaves silently: a hang_up could end the call for
    // the visitor and the monitor. An on-demand camera we opened is ours, so we
    // DO hang up — otherwise the panel keeps the video channel reserved and the
    // next auto-on is rejected with HTTP 409.
    if (sock.connected && this.sendHangup) {
      try {
        sock.emit('hang_up', {});
      } catch {
        /* ignore */
      }
      // Let the packet flush before the transport closes, or the panel never
      // sees the hang_up and the session lingers.
      setTimeout(close, 300);
    } else {
      close();
    }
  }
}
