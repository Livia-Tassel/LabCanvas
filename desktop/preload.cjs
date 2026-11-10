const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('labcanvasDesktop', { platform: process.platform, version: '1.0.0' });
window.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('desktop'));
const { ipcRenderer } = require('electron');
ipcRenderer.on('labcanvas:action', (_event, name) => {
  if (['import', 'table', 'project', 'help'].includes(name)) window.dispatchEvent(new CustomEvent('labcanvas:action', { detail: name }));
});
