const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
let window, running, ownsServer = false;
app.setName('LabCanvas');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    const home = path.resolve(process.env.LABCANVAS_HOME || path.join(os.homedir(), '.labcanvas'));
    try {
      // The packaged app contains its Node runtime and shares the same SQLite library with the CLI.
      const { startServer } = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'index.mjs')).href);
      try { running = await startServer({ home }); ownsServer = true; }
      catch (error) {
        if (error.code !== 'EADDRINUSE') throw error;
        const info = await fetch('http://127.0.0.1:4317/api/info', { signal: AbortSignal.timeout(1500) }).then(r => r.json()).catch(() => null);
        if (info?.home === home && info.version === '1.0.0') running = { url: 'http://127.0.0.1:4317' };
        else { running = await startServer({ home, port: 0 }); ownsServer = true; }
      }
      fs.writeFileSync(path.join(home, 'desktop-server.json'), JSON.stringify({ url: running.url, pid: process.pid }), { mode: 0o600 });
      const makeWindow = () => {
        window = new BrowserWindow({ width: 1500, height: 980, minWidth: 800, minHeight: 600, title: 'LabCanvas', backgroundColor: '#181818', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 17, y: 15 }, show: false,
          webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
        window.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith(`${running.url}/`)) void shell.openExternal(url); return { action: 'deny' }; });
        window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${running.url}/`)) event.preventDefault(); });
        window.webContents.on('will-prevent-unload', event => {
          const response = dialog.showMessageBoxSync(window, { type: 'question', buttons: ['继续编辑', '放弃修改并关闭'], defaultId: 0, cancelId: 0, message: '有未保存的修改', detail: '关闭窗口前，请保存表格或文本。' });
          if (response === 1) event.preventDefault();
        });
        window.on('ready-to-show', () => window.show());
        window.on('closed', () => { window = null; });
        void window.loadURL(running.url);
      };
      const emit = name => window?.webContents.send('labcanvas:action', name);
      const template = [
        { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
        { label: '文件', submenu: [{ label: '导入资料…', accelerator: 'CmdOrCtrl+O', click: () => emit('import') }, { label: '新建表格…', accelerator: 'CmdOrCtrl+N', click: () => emit('table') }, { label: '新建项目…', accelerator: 'CmdOrCtrl+Shift+N', click: () => emit('project') }, { type: 'separator' }, { role: 'close' }] },
        { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
        { label: '视图', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
        { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
        { label: '帮助', submenu: [{ label: '终端与资料库', click: () => emit('help') }, { label: '打开资料库文件夹', click: () => shell.openPath(home) }] }
      ];
      Menu.setApplicationMenu(Menu.buildFromTemplate(template)); makeWindow();
      app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) makeWindow(); });
    } catch (error) { console.error(error); dialog.showErrorBox('LabCanvas 启动失败', error.message); app.quit(); }
  });
}
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { if (ownsServer && running?.server) { running.server.close(); running.store.close(); } });
