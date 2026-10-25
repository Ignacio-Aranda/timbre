'use strict';

// Receives Fermax doorbell pushes over Firebase Cloud Messaging, in Node, the
// same way the Home Assistant integration does. We register as an FCM client
// using the app's own Firebase project, hand the resulting token to Fermax's
// cloud, and keep a long-lived MCS connection open to receive data messages.
//
// Fermax notification payload fields (from the Android app, XFirebaseMessagingService):
//   FermaxNotificationType : "Call" | "CallAttend" | "CallEnd" | "Autoon"
//                            | "ChangeVideoSource" | "FwUpdate" | "Logout" | "Info"
//   DeviceId, CallAs, AccessDoorKey, RoomId, SocketUrl (signaling URL),
//   PreviewTimeout, ConversationTimeout, StreamingMode,
//   NotificationTitle/…LocKey, NotificationBody/…LocKey, SendAcknowledge, FermaxToken

const { PushReceiver } = require('@eneris/push-receiver');
const { EventEmitter } = require('events');

// Keep the receiver alive: push-receiver can give up after repeated transport
// errors, so a watchdog reconnects it.
const WATCHDOG_INTERVAL_MS = 60_000;

class PushListener extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.firebase  { apiKey, appId, projectId, messagingSenderId, packageName }
   * @param {object|null} opts.credentials  Persisted push-receiver credentials, or null.
   * @param {string[]} opts.persistentIds  Already-seen message ids, to avoid replays.
   * @param {(creds)=>void} opts.onCredentials  Persist updated credentials.
   * @param {(ids)=>void} opts.onPersistentIds  Persist seen message ids.
   */
  constructor(opts) {
    super();
    this._firebase = opts.firebase;
    this._credentials = opts.credentials || undefined;
    this._persistentIds = opts.persistentIds || [];
    this._onCredentials = opts.onCredentials || (() => {});
    this._onPersistentIds = opts.onPersistentIds || (() => {});
    this._receiver = null;
    this._watchdog = null;
    this._started = false;
  }

  get fcmToken() {
    return this._receiver?.fcmToken || this._credentials?.fcm?.token || null;
  }

  _buildReceiver() {
    const fb = this._firebase;
    const receiver = new PushReceiver({
      firebase: {
        apiKey: fb.apiKey,
        appId: fb.appId,
        projectId: fb.projectId,
        messagingSenderId: String(fb.messagingSenderId),
      },
      bundleId: fb.packageName || 'com.fermax.blue.app',
      credentials: this._credentials,
      persistentIds: this._persistentIds,
    });

    receiver.onCredentialsChanged(({ newCredentials }) => {
      this._credentials = newCredentials;
      this._onCredentials(newCredentials);
      this.emit('token', this.fcmToken);
    });

    receiver.onNotification((envelope) => {
      try {
        this._handleEnvelope(envelope);
      } catch (err) {
        this.emit('error', err);
      }
    });

    return receiver;
  }

  _handleEnvelope(envelope) {
    // envelope: { message: { data, fcmMessageId, ... }, persistentId }
    const message = envelope.message || {};
    const data = message.data || {};
    const persistentId = envelope.persistentId;

    if (persistentId && !this._persistentIds.includes(persistentId)) {
      this._persistentIds.push(persistentId);
      // Bound the list so it does not grow forever.
      if (this._persistentIds.length > 256) {
        this._persistentIds = this._persistentIds.slice(-128);
      }
      this._onPersistentIds(this._persistentIds);
    }

    const type = data.FermaxNotificationType || '';
    const messageId = message.fcmMessageId || data.fcmMessageId || persistentId || '';

    this.emit('notification', {
      type,
      messageId,
      sendAck: String(data.SendAcknowledge).toLowerCase() === 'true',
      deviceId: data.DeviceId || null,
      callAs: data.CallAs || null,
      accessDoorKey: data.AccessDoorKey || null,
      roomId: data.RoomId || null,
      signalingUrl: data.SocketUrl || null,
      previewTimeout: numberOrNull(data.PreviewTimeout),
      conversationTimeout: numberOrNull(data.ConversationTimeout),
      streamingMode: data.StreamingMode || null,
      fermaxToken: data.FermaxToken || null,
      title: data.NotificationTitle || null,
      titleKey: data.NotificationTitleLocKey || null,
      body: data.NotificationBody || null,
      bodyKey: data.NotificationBodyLocKey || null,
      raw: data,
    });
  }

  async start() {
    if (this._started) return this.fcmToken;
    this._receiver = this._buildReceiver();
    await this._receiver.connect();
    this._started = true;
    this._startWatchdog();
    this.emit('token', this.fcmToken);
    return this.fcmToken;
  }

  _startWatchdog() {
    this._stopWatchdog();
    this._watchdog = setInterval(() => {
      // push-receiver reconnects internally; if the instance is gone, rebuild.
      if (this._started && !this._receiver) {
        this.start().catch((err) => this.emit('error', err));
      }
    }, WATCHDOG_INTERVAL_MS);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  _stopWatchdog() {
    if (this._watchdog) {
      clearInterval(this._watchdog);
      this._watchdog = null;
    }
  }

  async stop() {
    this._stopWatchdog();
    this._started = false;
    if (this._receiver) {
      try {
        this._receiver.destroy();
      } catch {
        /* ignore */
      }
      this._receiver = null;
    }
  }
}

function numberOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { PushListener };
