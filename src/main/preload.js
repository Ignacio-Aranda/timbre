'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The single, audited surface the renderer gets. No Node, no fs, no direct IPC.
contextBridge.exposeInMainWorld('timbre', {
  // State and logs (main -> renderer)
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onLog: (cb) => ipcRenderer.on('log', (_e, line) => cb(line)),
  requestState: () => ipcRenderer.invoke('state:get'),

  // Platform / theme (native look)
  getEnv: () => ipcRenderer.invoke('env:get'),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, env) => cb(env)),

  // Navigation: open the full window on a view (home only receives go-view)
  openMain: (view) => ipcRenderer.invoke('main:open', view),
  onGoView: (cb) => ipcRenderer.on('go-view', (_e, view) => cb(view)),

  // Setup
  pickAndExtractApk: () => ipcRenderer.invoke('apk:pick-and-extract'),
  saveAccount: (creds) => ipcRenderer.invoke('account:save', creds),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // Devices (renderer -> main)
  openCamera: (deviceId) => ipcRenderer.invoke('camera:open', { deviceId }),
  openDoorDevice: (deviceId, doorName) => ipcRenderer.invoke('door:open', { deviceId, doorName }),

  // Testing
  simulateCall: () => ipcRenderer.invoke('debug:simulate-call'),

  // Camera / call in the flyout (main -> renderer)
  onIncomingCall: (cb) => ipcRenderer.on('incoming-call', (_e, info) => cb(info)),
  onCallEnded: (cb) => ipcRenderer.on('call:ended', (_e, info) => cb(info)),
  onSwitchRoom: (cb) => ipcRenderer.on('switch-room', (_e, info) => cb(info)),

  // Camera / call in the flyout (renderer -> main)
  openDoor: (info) => ipcRenderer.invoke('call:open-door', info),
  switchCamera: (deviceId) => ipcRenderer.invoke('camera:switch', { deviceId }),
  callEnded: () => ipcRenderer.send('flyout:ended'),
  callLog: (line) => ipcRenderer.invoke('call:log', line),
});
