const { contextBridge, ipcRenderer } = require('electron');
const version = process.argv.find(argument => argument.startsWith('--labcanvas-version='))?.split('=')[1] ?? '';
contextBridge.exposeInMainWorld('labcanvasDesktop', { platform: process.platform, version });
window.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('desktop'));
// Commands chosen in the application menu; the page decides what they mean where it is.
ipcRenderer.on('labcanvas:action', (_event, name) => {
  if (typeof name === 'string' && /^[A-Za-z]{1,32}$/.test(name)) window.dispatchEvent(new CustomEvent('labcanvas:action', { detail: name }));
});
