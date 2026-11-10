import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const home = await mkdtemp(path.join(os.tmpdir(), 'labcanvas-packaged-'));
let application;
try {
  const artifact = JSON.parse(await readFile('release/artifact.json', 'utf8'));
  const executablePath = path.join(artifact.app_path, 'Contents', 'MacOS', 'LabCanvas');
  application = await electron.launch({ executablePath, env: { ...process.env, LABCANVAS_HOME: home }, timeout: 30000 });
  const errors = []; const page = await application.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => { if (message.type() === 'error') console.error('renderer:', message.text()); });
  page.on('response', response => { if (response.status() >= 400) console.error(response.status(), response.url()); });
  await expect(page.getByTestId('canvas')).toBeVisible(); await expect(page.locator('.canvas-card')).toHaveCount(5);
  await expect.poll(() => page.locator('.canvas img').evaluateAll(images => images.every(i => i.complete && i.naturalWidth > 0))).toBeTruthy();
  const info = await application.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged, node: process.versions.node }));
  if (!info.packaged) throw new Error('Expected the packaged application');
  const url = page.url(); const projects = await fetch(`${url}api/projects`).then(r => r.json()), project = projects[0];
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(i => i.label === '帮助').submenu.items[0].click());
  await expect(page.getByRole('dialog', { name: '终端与资料库' })).toBeVisible();
  const helpResponse = await fetch(`${url}api/help`); if (helpResponse.status !== 200) throw new Error('Packaged documentation is missing');
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByRole('button', { name: '适应全部资料', exact: true }).click(); await page.screenshot({ path: 'docs/screenshot-desktop.png' });
  await page.getByRole('button', { name: '列表视图', exact: true }).click(); await page.screenshot({ path: 'docs/screenshot-list.png' });
  const snapshot = await fetch(`${url}api/projects/${project.id}/snapshot`).then(r => r.json());
  const group = snapshot.groups.find(g => g.title.startsWith('吞吐量'));
  await page.getByTestId(`row-${group.id}`).dblclick(); await page.locator('.group-tabs').getByRole('button', { name: '吞吐量对比', exact: true }).click();
  await expect(page.getByRole('grid')).toBeVisible(); await page.screenshot({ path: 'docs/screenshot-table.png' });
  await page.locator('[data-cell="1:1"]').click(); await page.getByLabel('单元格内容', { exact: true }).fill('200.5');
  // Cancel a native close while dirty; the app and its database must stay usable.
  await application.evaluate(({ BrowserWindow, dialog }) => { dialog.showMessageBoxSync = () => 0; BrowserWindow.getAllWindows()[0].close(); });
  await expect(page.getByRole('grid')).toBeVisible();
  const health = await fetch(`${url}api/health`).then(r => r.json()); if (!health.ok) throw new Error('Canceling close stopped the server');
  await page.getByRole('button', { name: '保存', exact: true }).click(); await expect(page.locator('.unsaved-label')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByRole('button', { name: /^运行记录/ }).click(); await expect(page.locator('.run-file')).toHaveCount(2); await page.screenshot({ path: 'docs/screenshot-runs.png' });
  const form = new FormData(); form.append('files', new Blob([await readFile('tests/fixtures/sample.pdf')], { type: 'application/pdf' }), 'sample.pdf');
  const upload = await fetch(`${url}api/projects/${project.id}/uploads`, { method: 'POST', body: form }); if (!upload.ok) throw new Error('PDF import failed'); const pdf = await upload.json();
  await page.getByRole('button', { name: /^全部资料/ }).click(); await page.getByRole('button', { name: '刷新资料', exact: true }).click();
  await page.getByTestId(`row-${pdf.items[0].id}`).dblclick();
  await expect.poll(() => page.locator('.pdf-canvas').evaluate(c => { if (!c.width || !c.height) return 0; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 180 && d[i+1] < 180 && d[i+2] < 180 && d[i+3] > 200) n++; return n; }), { timeout: 15000 }).toBeGreaterThan(500);
  await page.screenshot({ path: 'docs/screenshot-pdf.png' });
  if (errors.length) throw new Error(errors.join('\n'));
  const report = { ...info, ok: true, checked_at: new Date().toISOString(), checks: ['packaged startup', 'native menu IPC', 'real image previews', 'bundled agent documentation', 'XLSX editing', 'cancel native close with unsaved data', 'time-based logs', 'built-in PDF rendering'], page_errors: errors };
  await writeFile('docs/desktop-verification.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const page = application?.windows()[0];
  if (page) { await page.screenshot({path:'docs/desktop-failure.png'}).catch(()=>{}); console.error((await page.locator('body').innerText()).slice(-4000)); }
  throw error;
} finally { await application?.close(); await rm(home, { recursive: true, force: true }); }
