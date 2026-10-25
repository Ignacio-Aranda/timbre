'use strict';

// Fermax DuoxMe / Blue cloud REST client.
//
// Reconstructed from the official Android app (com.fermax.blue.app 4.4.1) and
// cross-checked with the open-source Home Assistant integration. Endpoints,
// payload field names and headers mirror what the app sends so the cloud treats
// this client like any other paired device.
//
// Auth is OAuth2 password grant against oauth-pro-duoxme.fermax.io; every other
// call carries a Bearer access token and the app's custom headers.

const APP_VERSION = '4.4.1';
const APP_BUILD = '759';
const OS_NAME = 'ANDROID';
const OS_VERSION = '14';

// Headers the app attaches to every request (NetworkProvider interceptor).
function appHeaders() {
  return {
    'App-Version': APP_VERSION,
    'App-Build': APP_BUILD,
    'Phone-OS': `${OS_NAME} ${OS_VERSION} desktop`,
    'Phone-Model': 'Timbre-Desktop',
    'Accept-Language': 'es',
  };
}

const TOKEN_EXPIRY_MARGIN_S = 60;
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_RETRIES = 3;

class FermaxAuthError extends Error {}
class FermaxApiError extends Error {}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

class FermaxApi {
  /**
   * @param {object} opts
   * @param {string} opts.authUrl   OAuth token endpoint (full URL).
   * @param {string} opts.baseUrl   API base URL.
   * @param {string} opts.authBasic "Basic <base64>" header for the OAuth client.
   * @param {() => {username,password}|null} opts.getAccount  Account supplier.
   * @param {(creds)=>void} [opts.onToken]  Called when tokens change, to persist.
   * @param {object} [opts.tokens]  Previously persisted { accessToken, refreshToken, expiresAt }.
   */
  constructor(opts) {
    this.authUrl = opts.authUrl;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.authBasic = opts.authBasic;
    this.getAccount = opts.getAccount;
    this.onToken = opts.onToken || (() => {});
    this._access = opts.tokens?.accessToken || null;
    this._refresh = opts.tokens?.refreshToken || null;
    this._expiresAt = opts.tokens?.expiresAt || 0;
  }

  get isAuthenticated() {
    return !!this._access && Date.now() / 1000 < this._expiresAt;
  }

  _persistTokens() {
    this.onToken({
      accessToken: this._access,
      refreshToken: this._refresh,
      expiresAt: this._expiresAt,
    });
  }

  async _oauthRequest(body) {
    const res = await fetchWithTimeout(
      this.authUrl,
      {
        method: 'POST',
        headers: {
          Authorization: this.authBasic,
          'Content-Type': 'application/x-www-form-urlencoded',
          ...appHeaders(),
        },
        body,
      },
      DEFAULT_TIMEOUT_MS
    );
    let data;
    try {
      data = await res.json();
    } catch {
      throw new FermaxApiError(`El endpoint OAuth devolvió una respuesta no-JSON (HTTP ${res.status})`);
    }
    if (data.error) {
      if (data.error === 'invalid_client') {
        throw new FermaxAuthError(
          'Autenticación del cliente OAuth fallida (invalid_client). Revisa las credenciales extraídas del APK.'
        );
      }
      throw new FermaxAuthError(`OAuth: ${data.error}${data.error_description ? ' — ' + data.error_description : ''}`);
    }
    if (!res.ok || !data.access_token) {
      throw new FermaxApiError(`OAuth falló (HTTP ${res.status})`);
    }
    this._access = data.access_token;
    if (data.refresh_token) this._refresh = data.refresh_token;
    this._expiresAt = Date.now() / 1000 + (data.expires_in || 3600) - TOKEN_EXPIRY_MARGIN_S;
    this._persistTokens();
    return data;
  }

  async authenticate() {
    const account = this.getAccount();
    if (!account?.username || !account?.password) {
      throw new FermaxAuthError('No hay credenciales de cuenta configuradas');
    }
    const body =
      'grant_type=password' +
      '&username=' +
      encodeURIComponent(account.username) +
      '&password=' +
      encodeURIComponent(account.password);
    return this._oauthRequest(body);
  }

  async refreshToken() {
    if (!this._refresh) return this.authenticate();
    try {
      return await this._oauthRequest(
        'grant_type=refresh_token&refresh_token=' + encodeURIComponent(this._refresh)
      );
    } catch (err) {
      if (err instanceof FermaxAuthError) return this.authenticate();
      throw err;
    }
  }

  async _ensureAuth() {
    if (this.isAuthenticated) return;
    if (this._refresh) await this.refreshToken();
    else await this.authenticate();
  }

  async getAccessToken() {
    await this._ensureAuth();
    return this._access;
  }

  _authHeaders() {
    return {
      Authorization: `Bearer ${this._access}`,
      'Content-Type': 'application/json',
      ...appHeaders(),
    };
  }

  async _request(method, pathPart, { body, query } = {}) {
    await this._ensureAuth();
    let url = this.baseUrl + pathPart;
    if (query) {
      const qs = new URLSearchParams(query).toString();
      url += (url.includes('?') ? '&' : '?') + qs;
    }
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetchWithTimeout(
          url,
          {
            method,
            headers: this._authHeaders(),
            body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
          },
          DEFAULT_TIMEOUT_MS
        );
        if (res.status === 401) {
          // Token rejected: refresh once and retry immediately.
          this._access = null;
          await this._ensureAuth();
          if (attempt === 0) continue;
        }
        if (!res.ok) {
          const err = new FermaxApiError(`${method} ${pathPart} → HTTP ${res.status}`);
          err.status = res.status;
          // A command the server may have already run must not be blindly retried.
          if (res.status >= 500 && attempt < MAX_RETRIES) {
            lastErr = err;
            await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
            continue;
          }
          throw err;
        }
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      } catch (err) {
        lastErr = err;
        const transient = err.name === 'AbortError' || err.code === 'ECONNRESET' || err instanceof TypeError;
        if (transient && method === 'GET' && attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  // ----- Devices and pairings -------------------------------------------

  async getPairings() {
    const data = await this._request('GET', '/pairing/api/v4/pairings/me');
    return (data || []).map((item) => {
      const accessDoors = {};
      for (const [name, door] of Object.entries(item.accessDoorMap || {})) {
        accessDoors[name] = {
          name,
          title: door.title || name,
          accessId: door.accessId,
          visible: door.visible ?? false,
        };
      }
      for (const door of item.panelAccessDoors || []) {
        const d = door.doorId;
        const name = `${door.deviceId}_${d.block}_${d.subblock}_${d.number}`;
        accessDoors[name] = {
          name,
          title: door.title || name,
          accessId: d,
          visible: door.isVisible ?? false,
          panelId: door.deviceId,
        };
      }
      return {
        deviceId: item.deviceId,
        tag: item.tag || '',
        installationId: item.installationId || '',
        master: !!item.master,
        accessDoors,
      };
    });
  }

  async getDeviceInfo(deviceId) {
    return this._request('GET', `/deviceaction/api/v1/device/${deviceId}`);
  }

  // ----- Door opening ----------------------------------------------------

  async openDoor(deviceId, accessId, panelId = null) {
    const target = panelId || deviceId;
    const query = panelId ? { unitId: deviceId } : undefined;
    await this._request('POST', `/deviceaction/api/v1/device/${target}/directed-opendoor`, {
      body: JSON.stringify(accessId),
      query,
    });
    return true;
  }

  async openDoorInCall({ deviceId, roomId, fcmToken, callAs }) {
    await this._request('POST', '/deviceaction/api/v1/device/incall/opendoor', {
      body: { deviceId, roomId, appTokenId: fcmToken, unitId: callAs },
    });
    return true;
  }

  // ----- Camera on demand (auto-on) -------------------------------------

  async autoOn(deviceId, fcmToken) {
    return this._request('POST', `/deviceaction/api/v2/device/${deviceId}/autoon`, {
      body: { directedToBluestream: fcmToken, directedToSippo: null, callAs: null },
    });
  }

  // ----- Push token registration ----------------------------------------

  async registerAppToken(fcmToken, { active = true, force = false } = {}) {
    const body = {
      active,
      force,
      token: fcmToken,
      id: fcmToken,
      appVersion: APP_VERSION,
      appBuild: APP_BUILD,
      locale: 'es_ES',
      os: OS_NAME,
      osVersion: OS_VERSION,
      phoneMobile: 'Timbre-Desktop',
    };
    try {
      await this._request('POST', '/notification/api/v2/apptoken', { body });
      return { ok: true };
    } catch (err) {
      if (err.status === 409) return { ok: false, sessionLimit: true };
      throw err;
    }
  }

  async unregisterAppToken(fcmToken) {
    const body = { active: false, token: fcmToken, id: fcmToken };
    try {
      await this._request('DELETE', `/notification/api/v2/apptoken/${encodeURIComponent(fcmToken)}`, { body });
    } catch {
      /* best effort on shutdown */
    }
  }

  // ----- Notification acknowledgement -----------------------------------

  async ackNotification(messageId, { isCall }) {
    const path = isCall ? '/callmanager/api/v1/message/ack' : '/notification/api/v1/message/ack';
    try {
      await this._request('POST', path, { body: { attended: true, fcmMessageId: messageId } });
    } catch {
      /* ack is best-effort */
    }
  }

  // ----- Call photo / log -----------------------------------------------

  async getCallPhoto(photoId) {
    const data = await this._request('GET', '/callmanager/api/v1/photocall', {
      query: { photoId },
    });
    const b64 = data?.image?.data;
    return b64 ? Buffer.from(b64, 'base64') : null;
  }
}

module.exports = { FermaxApi, FermaxAuthError, FermaxApiError, appHeaders };
