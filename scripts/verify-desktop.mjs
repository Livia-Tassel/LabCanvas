import { _electron as electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.mjs';
import { Store } from '../server/store.mjs';

const home = await mkdtemp(path.join(os.tmpdir(), 'labcanvas-desktop-'));
const screenshots = path.resolve('test-results/desktop');
const source = process.argv.includes('--source');
let application;
let server;
let page;

try {
  const store = new Store(home);
  let entry;
  try {
    const project = store.createProject({ name: 'AgentFS 桌面验收' });
    entry = await store.createEntry(project.id, {
      title: '缓存延迟',
      collections: ['实验目的/Baseline', '模块/含有很长名称的分类名称用于验证布局及省略显示'],
      files: ['examples/results.csv', 'examples/result.svg', 'tests/fixtures/sample.pdf'].map(file => ({ path: path.resolve(file) }))
    });
  } finally {
    store.close();
  }
  if (source) server = await startServer({ home, port: 0 });

  let launch = { args: ['.'] };
  if (!source) {
    const artifact = JSON.parse(await readFile('release/artifact.json', 'utf8'));
    launch = { executablePath: path.join(artifact.app_path, 'Contents', 'MacOS', 'LabCanvas') };
  }
  application = await electron.launch({
    ...launch,
    env: { ...process.env, PORT: server ? new URL(server.url).port : '0', LABCANVAS_HOME: home, LABCANVAS_PROFILE: path.join(home, 'profile') },
    timeout: 30000
  });
  const errors = [];
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(!source);
  if (server) await expect(page).toHaveURL(`${server.url}/`);
  await expect(page.locator('html')).toHaveClass(/desktop/);
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.locator('.preview-table')).toContainText('Baseline');
  await expect.poll(() => page.locator('.kind-image img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  await expect.poll(() => page.locator('.preview-pdf img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  await expect.poll(() => page.locator('.project-switch').evaluate(button => button.getBoundingClientRect().top)).toBeGreaterThanOrEqual(36);

  await mkdir(screenshots, { recursive: true });
  const screenshot = name => page.screenshot({ path: path.join(screenshots, name) });
  await screenshot('canvas.png');

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 600));
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.locator('.toolbar-title').evaluate(title => title.clientWidth)).toBeGreaterThanOrEqual(56);
  await page.getByRole('button', { name: '缩放以显示全部' }).click();
  await page.locator('.card-title').click();
  await page.locator('.chips').getByRole('button', { name: '添加', exact: true }).click();
  const selector = page.getByRole('dialog');
  await expect(selector.getByRole('checkbox')).toHaveCount(4);
  const dimensions = await selector.getByRole('checkbox').evaluateAll(inputs => inputs.map(input => {
    const bounds = input.getBoundingClientRect();
    return [bounds.width, bounds.height];
  }));
  expect(dimensions.every(([width, height]) => width >= 10 && height >= 10 && width <= 20 && height <= 20)).toBeTruthy();
  expect(await selector.locator('.check-tree').evaluate(tree => tree.scrollWidth - tree.clientWidth)).toBeLessThanOrEqual(1);
  await screenshot('compact-dark.png');
  await selector.getByRole('button', { name: '取消' }).click();

  await application.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label === '帮助').submenu.items.find(item => item.label === '终端与资料库').click());
  await expect(page.getByRole('dialog', { name: '终端与资料库' })).toContainText('labcanvas add');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label === '视图').submenu.items.find(item => item.label === '添加便签').click());
  await expect(page.locator('.note')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.locator('.note').click();
  await page.keyboard.press('Backspace');
  await expect(page.locator('.note')).toHaveCount(0);

  await page.getByRole('tab', { name: '列表' }).click();
  await page.getByRole('row', { name: /^缓存延迟/ }).dblclick();
  const grid = page.getByRole('grid');
  await expect(grid.locator('[data-row="1"][data-column="1"]')).toBeVisible();
  await page.getByLabel('单元格内容').fill('150.5');
  await expect(page.locator('.unsaved')).toBeVisible();
  await application.evaluate(({ BrowserWindow, dialog }) => {
    dialog.showMessageBoxSync = () => 0;
    BrowserWindow.getAllWindows()[0].close();
  });
  await expect(grid).toBeVisible();
  await expect(page.getByLabel('单元格内容')).toHaveValue('150.5');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(grid.locator('[data-row="0"][data-column="0"]')).toHaveText('150.5');
  await expect.poll(async () => {
    const response = await page.request.get(new URL(`/api/files/${entry.files[0].id}/versions`, page.url()).href);
    return (await response.json()).length;
  }).toBe(2);
  await screenshot('table-dark.png');
  await page.getByRole('tab', { name: 'sample.pdf' }).click();
  await expect.poll(() => page.locator('.pdf-page canvas').evaluate(canvas => canvas.width)).toBeGreaterThan(300);
  expect(errors).toEqual([]);
  const child = application.process();
  const shutdownTimer = setTimeout(() => child.kill('SIGTERM'), 10000);
  try {
    await application.close();
    expect(child.exitCode).toBe(0);
  } finally {
    clearTimeout(shutdownTimer);
    application = undefined;
  }
  console.log(`Electron ${source ? 'source' : 'packaged'} checks passed. Screenshots saved to ${screenshots}`);
} catch (error) {
  if (page) {
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, 'failure.png') }).catch(() => {});
  }
  throw error;
} finally {
  await application?.close();
  await server?.stop();
  await rm(home, { recursive: true, force: true });
}
