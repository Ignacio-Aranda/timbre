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

  // Setup
  pickAndExtractApk: () => ipcRenderer.invoke('apk:pick-and-extract'),
  saveAccount: (creds) => ipcRenderer.invoke('account:save', creds),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // Devices (home -> main)
  openCamera: (deviceId) => ipcRenderer.invoke('camera:open', { deviceId }),
  openDoorDevice: (deviceId, doorName) => ipcRenderer.invoke('door:open', { deviceId, doorName }),

  // Testing
  simulateCall: () => ipcRenderer.invoke('debug:simulate-call'),

  // Call window (main -> renderer)
  onIncomingCall: (cb) => ipcRenderer.on('incoming-call', (_e, info) => cb(info)),
  onCallEnded: (cb) => ipcRenderer.on('call:ended', (_e, info) => cb(info)),
  onSwitchRoom: (cb) => ipcRenderer.on('switch-room', (_e, info) => cb(info)),

  // Call window (renderer -> main)
  openDoor: (info) => ipcRenderer.invoke('call:open-door', info),
  switchCamera: (deviceId) => ipcRenderer.invoke('camera:switch', { deviceId }),
  dismissCall: () => ipcRenderer.invoke('call:dismiss'),
  hideCall: () => ipcRenderer.send('call:hide'),
  callLog: (line) => ipcRenderer.invoke('call:log', line),
});
