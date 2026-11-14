const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  load: () => ipcRenderer.invoke('data:load'),
  save: (data) => ipcRenderer.invoke('data:save', data),
  refreshOutlook: () => ipcRenderer.invoke('outlook:refresh'),
  dismissPopup: () => ipcRenderer.invoke('popup:dismiss'),
  testPopup: () => ipcRenderer.invoke('popup:test'),
  info: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  onPopupMode: (cb) => ipcRenderer.on('popup:mode', (_e, on) => cb(on)),
  onOutlookUpdated: (cb) => ipcRenderer.on('outlook:updated', (_e, o) => cb(o))
});
