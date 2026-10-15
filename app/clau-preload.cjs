// Pont mínim entre la finestra de la clau i l'app: només aquestes dues funcions.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('clau', {
  desa: (key, force) => ipcRenderer.invoke('clau:desa', key, force),
  cancel: () => ipcRenderer.send('clau:cancel'),
});
