'use strict';

// Tiny JSON-file store in the app's userData directory. Two files:
//   settings.json      — user preferences and non-secret device data
//   credentials.json   — API/Firebase credentials + FCM registration + tokens
//
// credentials.json holds secrets. It is written with 0600 where the OS supports
// it and never leaves the machine. It is the local equivalent of what the phone
// app keeps in its own private storage.

const fs = require('fs');
const path = require('path');

class JsonFile {
  constructor(filePath, defaults = {}) {
    this.path = filePath;
    this.defaults = defaults;
    this.data = { ...defaults };
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.path, 'utf8');
      this.data = { ...this.defaults, ...JSON.parse(raw) };
    } catch {
      this.data = { ...this.defaults };
    }
  }

  get(key, fallback = undefined) {
    return key in this.data ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data[key] = value;
    this._save();
  }

  merge(obj) {
    Object.assign(this.data, obj);
    this._save();
  }

  all() {
    return { ...this.data };
  }

  _save() {
    const dir = path.dirname(this.path);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.path + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.path);
    try {
      fs.chmodSync(this.path, 0o600);
    } catch {
      /* Windows may ignore chmod; ACLs still protect userData */
    }
  }
}

function createStores(userDataDir) {
  const settings = new JsonFile(path.join(userDataDir, 'settings.json'), {
    autostart: true,
    startMinimized: false,
    ringSound: 'default',
    ringVolume: 0.9,
    ringForcesSound: true, // ring even if the OS is on silent / Do Not Disturb
    showVideoOnRing: true,
    theme: 'system',
    activeDeviceId: null,
  });
  const credentials = new JsonFile(path.join(userDataDir, 'credentials.json'), {
    firebase: null,
    fermax: null,
    app: null,
    account: null, // { username, password }
    fcm: null, // persistent push-receiver credentials
    persistentIds: [],
  });
  return { settings, credentials };
}

module.exports = { createStores, JsonFile };
