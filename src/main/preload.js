'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The single, audited surface the renderer gets. No Node, no fs, no direct IPC.
contextBridge.exposeInMainWorld('timbre', {
  // State and logs (main -> renderer)
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onLog: (cb) => ipcRenderer.on('log', (_e, line) => cb(line)),
  requestState: () => ipcRenderer.invoke('state:get'),

  // Setup
  pickAndExtractApk: () => ipcRenderer.invoke('apk:pick-and-extract'),
  saveAccount: (creds) => ipcRenderer.invoke('account:save', creds),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // Testing
  simulateCall: () => ipcRenderer.invoke('debug:simulate-call'),

  // Call window (main -> renderer)
  onIncomingCall: (cb) => ipcRenderer.on('incoming-call', (_e, info) => cb(info)),
  onCallEnded: (cb) => ipcRenderer.on('call:ended', (_e, info) => cb(info)),

  // Call window (renderer -> main)
  openDoor: (info) => ipcRenderer.invoke('call:open-door', info),
  dismissCall: () => ipcRenderer.invoke('call:dismiss'),
  hideCall: () => ipcRenderer.send('call:hide'),
  callLog: (line) => ipcRenderer.invoke('call:log', line),
});
