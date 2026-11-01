// Narrow bridge between the sandboxed UI and the desktop shell.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('goat', {
  info: () => ipcRenderer.invoke('app:info'),
  newWindow: () => ipcRenderer.invoke('app:newWindow'),
  retryRelay: () => ipcRenderer.invoke('app:retryRelay'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  saveFile: (name, data) => ipcRenderer.invoke('app:saveFile', { name, data }),
  saveTemp: (name, data, mime) => ipcRenderer.invoke('app:saveTemp', { name, data, mime }),
  openPath: (target) => ipcRenderer.invoke('app:openPath', target),
  revealPath: (target) => ipcRenderer.invoke('app:revealPath', target),
  setBadge: (count) => ipcRenderer.invoke('app:badge', count),
  setTheme: (mode) => ipcRenderer.invoke('app:theme', mode),
  session: {
    load: () => ipcRenderer.invoke('login:load'),
    save: (payload) => ipcRenderer.invoke('login:save', payload),
    clear: () => ipcRenderer.invoke('login:clear'),
  },
  requestMedia: (kind) => ipcRenderer.invoke('media:access', kind),
  net: {
    get: () => ipcRenderer.invoke('net:get'),
    test: (relayUrl) => ipcRenderer.invoke('net:test', { relayUrl }),
    set: (next) => ipcRenderer.invoke('net:set', next),
  },
  screen: {
    sources: () => ipcRenderer.invoke('screen:sources'),
    pick: (id, partition) => ipcRenderer.invoke('screen:pick', { id, partition }),
    clear: (partition) => ipcRenderer.invoke('screen:clear', { partition }),
    openPrefs: () => ipcRenderer.invoke('screen:openPrefs'),
  },
  partition: new URLSearchParams(location.search).get('partition') || 'persist:goat-main',
  platform: process.platform,
});
