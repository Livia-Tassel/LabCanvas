const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
let window, running, ownsServer = false;
app.setName('LabCanvas');
if (process.env.LABCANVAS_PROFILE) {
  const profile = path.resolve(process.env.LABCANVAS_PROFILE);
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    const home = path.resolve(process.env.LABCANVAS_HOME || path.join(os.homedir(), '.labcanvas'));
    try {
      // The packaged app contains its Node runtime and shares the same SQLite library with the CLI.
      const { startServer, VERSION } = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'index.mjs')).href);
      const port = Number(process.env.PORT || 4317);
      try { running = await startServer({ home, port }); ownsServer = true; }
      catch (error) {
        if (error.code !== 'EADDRINUSE') throw error;
        const url = `http://127.0.0.1:${port}`;
        const info = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(1500) }).then(r => r.json()).catch(() => null);
        if (info?.home === home && info.version === VERSION) running = { url };
        else { running = await startServer({ home, port: 0 }); ownsServer = true; }
      }
      fs.writeFileSync(path.join(home, 'desktop-server.json'), JSON.stringify({ url: running.url, pid: process.pid }), { mode: 0o600 });
      const makeWindow = () => {
        window = new BrowserWindow({ width: 1500, height: 980, minWidth: 800, minHeight: 600, title: 'LabCanvas', backgroundColor: '#181818', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 17, y: 15 }, show: false,
          webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, additionalArguments: [`--labcanvas-version=${VERSION}`] } });
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
      // Menu commands are carried out by the window, which already does the same for their keyboard shortcuts.
      const command = (label, name, accelerator) => ({ label, accelerator, click: () => window?.webContents.send('labcanvas:action', name) });
      const separator = { type: 'separator' };
      const template = [
        ...(process.platform === 'darwin' ? [{ label: app.name, submenu: [{ role: 'about' }, separator, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, separator, { role: 'quit' }] }] : []),
        { label: '文件', submenu: [
          command('添加文件…', 'import', 'CmdOrCtrl+O'),
          command('新建表格…', 'table', 'CmdOrCtrl+N'),
          command('新建项目…', 'project', 'CmdOrCtrl+Shift+N'),
          separator,
          command('导出…', 'export', 'CmdOrCtrl+E'),
          command('备份资料库…', 'backup'),
          separator,
          process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
        ] },
        { label: '编辑', submenu: [
          { role: 'undo' }, { role: 'redo' }, separator,
          { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, separator,
          command('查找', 'find', 'CmdOrCtrl+F')
        ] },
        { label: '视图', submenu: [
          command('画布', 'canvas', 'CmdOrCtrl+1'),
          command('列表', 'list', 'CmdOrCtrl+2'),
          separator,
          command('显示或隐藏详情面板', 'inspector', 'CmdOrCtrl+I'),
          separator,
          command('放大', 'zoomIn', 'CmdOrCtrl+='),
          command('缩小', 'zoomOut', 'CmdOrCtrl+-'),
          command('实际大小', 'actualSize'),
          command('缩放以显示全部', 'fit', 'CmdOrCtrl+0'),
          separator,
          command('整理排列', 'tidy'),
          command('添加便签', 'note'),
          command('添加分组框', 'frame'),
          separator,
          { role: 'togglefullscreen' },
          separator,
          { role: 'reload' }, { role: 'toggleDevTools' }
        ] },
        { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(process.platform === 'darwin' ? [{ role: 'front' }] : [])] },
        { label: '帮助', submenu: [
          command('键盘快捷键', 'shortcuts'),
          command('终端与资料库', 'help'),
          separator,
          { label: '打开资料库文件夹', click: () => shell.openPath(home) }
        ] }
      ];
      Menu.setApplicationMenu(Menu.buildFromTemplate(template)); makeWindow();
      app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) makeWindow(); });
    } catch (error) { console.error(error); dialog.showErrorBox('LabCanvas 启动失败', error.message); app.quit(); }
  });
}
app.on('window-all-closed', () => app.quit());
app.on('will-quit', event => {
  if (!ownsServer) return;
  event.preventDefault();
  ownsServer = false;
  // Window close and unsaved-edit checks finished before Electron emitted will-quit.
  void running.stop().finally(() => app.exit());
});
