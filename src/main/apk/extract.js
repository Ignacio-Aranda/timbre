'use strict';

// Reads the Fermax app configuration a user owns, out of their own APK.
//
// Everything here comes from files inside a publicly distributed app that the
// user installed as a paying customer. We never ship these values; the user
// points the app at their APK and the app reads them locally for interoperability.
//
// What we need and where it lives:
//   - Firebase (to receive the doorbell push): resources.arsc string resources
//       google_api_key, google_app_id, gcm_defaultSenderId, project_id
//   - OAuth client (to log in): BuildConfig in a DEX
//       OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET   (app 4.3.4+)
//   - Server URLs: the production hosts, confirmed against strings in the DEX.

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const yauzl = require('yauzl');
const { DexFile } = require('./dex');
const { readStringResources } = require('./arsc');

const yauzlOpen = promisify(yauzl.open);

const PRODUCTION_AUTH_URL = 'https://oauth-pro-duoxme.fermax.io/oauth/token';
const PRODUCTION_BASE_URL = 'https://pro-duoxme.fermax.io';
const PRODUCTION_SIGNALING_URL = 'https://signaling-pro-duoxme.fermax.io';

const APP_ID_RE = /^1:\d+:android:[0-9a-f]+$/;
const API_KEY_RE = /^AIza[\w-]{20,}$/;

// Reads one entry from an open zip into a Buffer.
function readZipEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

// Collects selected entries from a zip. `want(name)` decides what to keep.
async function collectEntries(apkPath, want) {
  const zip = await yauzlOpen(apkPath, { lazyEntries: true });
  const out = new Map();
  return await new Promise((resolve, reject) => {
    zip.on('entry', (entry) => {
      if (want(entry.fileName)) {
        readZipEntry(zip, entry)
          .then((buf) => {
            out.set(entry.fileName, buf);
            zip.readEntry();
          })
          .catch(reject);
      } else {
        zip.readEntry();
      }
    });
    zip.on('end', () => resolve(out));
    zip.on('error', reject);
    zip.readEntry();
  });
}

function firebaseFromResources(arscBuf) {
  const res = readStringResources(arscBuf);
  const apiKey = res.get('google_api_key');
  const appId = res.get('google_app_id');
  const senderId = res.get('gcm_defaultSenderId');
  const projectId = res.get('project_id');
  const packageName = res.get('project_id') ? res.get('package_name') : undefined;
  if (!apiKey || !appId || !senderId || !projectId) {
    const missing = [
      ['google_api_key', apiKey],
      ['google_app_id', appId],
      ['gcm_defaultSenderId', senderId],
      ['project_id', projectId],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    throw new Error('Firebase: faltan recursos en el APK: ' + missing.join(', '));
  }
  if (!API_KEY_RE.test(apiKey)) throw new Error('Firebase: google_api_key no tiene el formato esperado');
  if (!APP_ID_RE.test(appId)) throw new Error('Firebase: google_app_id no tiene el formato esperado');
  return { apiKey, appId, senderId: String(senderId), projectId, packageName };
}

// Searches the DEX files for BuildConfig OAuth constants (app 4.3.4+).
// Telemetry constants (TRACING_BASIC_AUTH and the like) are never OAuth and are
// ignored: the login endpoint rejects them.
function oauthFromDex(dexBuffers, applicationId) {
  const descriptors = [];
  if (applicationId) {
    descriptors.push('L' + applicationId.replace(/\./g, '/') + '/BuildConfig;');
  }
  for (const buf of dexBuffers) {
    let dex;
    try {
      dex = new DexFile(buf);
    } catch {
      continue;
    }
    for (const descriptor of descriptors) {
      let fields;
      try {
        fields = dex.staticValues(descriptor);
      } catch {
        fields = null;
      }
      if (!fields) continue;
      const clientId = fields.OAUTH_CLIENT_ID;
      const clientSecret = fields.OAUTH_CLIENT_SECRET;
      if (typeof clientId === 'string' && typeof clientSecret === 'string' && clientId && clientSecret) {
        return { clientId, clientSecret };
      }
    }
  }
  return null;
}

function buildBasicAuth(clientId, clientSecret) {
  const encoded = Buffer.from(
    `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
    'utf8'
  ).toString('base64');
  return 'Basic ' + encoded;
}

// Confirms the production URLs are present in the app rather than hardcoding
// blindly: if a future build moves them, we fail loudly instead of guessing.
function confirmUrls(dexBuffers) {
  const hosts = ['oauth-pro-duoxme.fermax.io', 'pro-duoxme.fermax.io', 'signaling-pro-duoxme.fermax.io'];
  const seen = new Set();
  for (const buf of dexBuffers) {
    const text = buf.toString('latin1');
    for (const h of hosts) if (text.includes(h)) seen.add(h);
  }
  return hosts.every((h) => seen.has(h));
}

function readAppVersion(dexBuffers, applicationId) {
  if (!applicationId) return null;
  const descriptor = 'L' + applicationId.replace(/\./g, '/') + '/BuildConfig;';
  for (const buf of dexBuffers) {
    try {
      const dex = new DexFile(buf);
      const fields = dex.staticValues(descriptor);
      if (fields && fields.VERSION_NAME) {
        return { versionName: String(fields.VERSION_NAME), versionCode: fields.VERSION_CODE ?? null };
      }
    } catch {
      /* next dex */
    }
  }
  return null;
}

/**
 * Extracts a complete credential set from one or more APK files that belong to
 * the same installed app (a base.apk, optionally with its split APKs).
 *
 * @param {string[]} apkPaths  Absolute paths to the user's APK(s).
 * @returns {Promise<object>}  { firebase, fermax, app } ready to persist.
 */
async function extractCredentials(apkPaths) {
  if (!apkPaths || apkPaths.length === 0) throw new Error('No se indicó ningún APK');

  let arscBuf = null;
  const dexBuffers = [];
  let applicationId = null;

  for (const apkPath of apkPaths) {
    const entries = await collectEntries(
      apkPath,
      (name) => name === 'resources.arsc' || /^classes\d*\.dex$/.test(name)
    );
    for (const [name, buf] of entries) {
      if (name === 'resources.arsc' && !arscBuf) arscBuf = buf;
      else if (name.endsWith('.dex')) dexBuffers.push(buf);
    }
  }

  if (!arscBuf) throw new Error('Ningún APK contenía resources.arsc (¿falta el base.apk?)');
  if (dexBuffers.length === 0) throw new Error('Ningún APK contenía clases DEX (¿falta el base.apk?)');

  const firebase = firebaseFromResources(arscBuf);
  applicationId = firebase.packageName || 'com.fermax.blue.app';

  const oauth = oauthFromDex(dexBuffers, applicationId);
  if (!oauth) {
    throw new Error(
      'No se encontraron OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET en BuildConfig. ' +
        'Puede que esta versión de la app use el formato antiguo cifrado (4.3.0 o anterior).'
    );
  }

  const urlsOk = confirmUrls(dexBuffers);
  const version = readAppVersion(dexBuffers, applicationId);

  return {
    firebase: {
      apiKey: firebase.apiKey,
      appId: firebase.appId,
      projectId: firebase.projectId,
      messagingSenderId: firebase.senderId,
      packageName: applicationId,
    },
    fermax: {
      authUrl: PRODUCTION_AUTH_URL,
      baseUrl: PRODUCTION_BASE_URL,
      signalingUrl: PRODUCTION_SIGNALING_URL,
      authBasic: buildBasicAuth(oauth.clientId, oauth.clientSecret),
      urlsConfirmedInApk: urlsOk,
    },
    app: {
      applicationId,
      versionName: version ? version.versionName : null,
      versionCode: version ? version.versionCode : null,
      extractedFrom: apkPaths.map((p) => path.basename(p)),
    },
  };
}

module.exports = {
  extractCredentials,
  buildBasicAuth,
  PRODUCTION_AUTH_URL,
  PRODUCTION_BASE_URL,
  PRODUCTION_SIGNALING_URL,
};
