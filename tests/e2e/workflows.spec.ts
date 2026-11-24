import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import ExcelJS from 'exceljs';
import sharp from 'sharp';

const exec = promisify(execFile);
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const csv = { name: '延迟.csv', mimeType: 'text/csv', buffer: Buffer.from('批次,延迟\nBaseline,12\nAgentFS,8\n') };
const figure = 'examples/result.svg';
const title = '缓存延迟结果';

async function workspace(page: Page, request: APIRequestContext, name: string) {
  const response = await request.post('/api/projects', { data: { name } });
  expect(response.ok()).toBeTruthy();
  const project = await response.json();
  await page.addInitScript(id => localStorage.setItem('labcanvas.project', id), project.id);
  await page.goto('/');
  await expect(page.locator('.project-switch')).toHaveText(name);
  return project;
}

async function chooseFiles(page: Page, files: Parameters<ReturnType<Page['locator']>['setInputFiles']>[0]) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '添加文件', exact: true }).click();
  await (await chooser).setFiles(files);
}

test('项目创建、重命名、切换和隔离', async ({ page, request }) => {
  const original = await workspace(page, request, '原项目');
  await chooseFiles(page, csv);
  await expect(page.locator('.card-title')).toHaveText('延迟');
  await page.locator('.project-switch').click();
  await page.getByRole('menuitem', { name: '新建项目…' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('项目名称').fill('隔离项目');
  await dialog.getByLabel('项目名称').press('Enter');
  await expect(page.locator('.project-switch')).toHaveText('隔离项目');
  await expect(page.locator('.card')).toHaveCount(0);
  await page.locator('.project-switch').click();
  await page.getByRole('menuitem', { name: '重命名项目…' }).click();
  await dialog.locator('input').fill('隔离项目改名');
  await dialog.getByRole('button', { name: '确定' }).click();
  await expect(page.locator('.project-switch')).toHaveText('隔离项目改名');
  await page.locator('.project-switch').click();
  await page.getByRole('menuitem', { name: original.name, exact: true }).click();
  await expect(page.locator('.card-title')).toHaveText('延迟');
});

test('组合缩略图、来源、分类引用、回收和永久删除', async ({ page, request }) => {
  const project = await workspace(page, request, '组合与分类');
  await chooseFiles(page, [csv, { name: '对比图.svg', mimeType: 'image/svg+xml', buffer: await readFile(figure) }]);
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('标题').fill(title);
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  const card = page.locator('.card');
  await expect(card.locator('td', { hasText: 'Baseline' })).toBeVisible();
  await expect(card.locator('img')).toHaveJSProperty('complete', true);
  await expect.poll(() => card.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await card.locator('.card-title').click();
  await expect(page.locator('.file-row-meta', { hasText: '来自 延迟.csv' })).toBeVisible();
  await page.locator('.chips').getByRole('button', { name: '添加', exact: true }).click();
  await dialog.getByRole('textbox', { name: '新分类' }).fill('实验目的/Baseline');
  await dialog.getByRole('button', { name: '完成' }).click();
  await expect(page.locator('.chip-label', { hasText: 'Baseline' })).toBeVisible();
  await page.getByRole('button', { name: '新建分类', exact: true }).click();
  await dialog.getByLabel('名称').fill('模块');
  await dialog.getByRole('button', { name: '创建' }).click();
  await page.locator('.chips').getByRole('button', { name: '添加', exact: true }).click();
  await dialog.getByRole('checkbox', { name: '模块', exact: true }).check();
  await dialog.getByRole('button', { name: '完成' }).click();
  await page.locator('.sidebar').getByRole('button', { name: /^Baseline/ }).click();
  await card.locator('.card-title').click();
  await page.keyboard.press('Backspace');
  await expect(card).toHaveCount(0);
  await page.locator('.sidebar').getByRole('button', { name: /^模块/ }).click();
  await card.locator('.card-title').click();
  await page.keyboard.press('Shift+Backspace');
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: /^回收站/ }).click();
  const row = page.getByRole('row', { name: new RegExp(title) });
  await row.click();
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.locator('.sidebar').getByRole('button', { name: /^模块/ }).click();
  await expect(card.locator('.card-title')).toHaveText(title);
  await card.locator('.card-title').click();
  await page.keyboard.press('Shift+Backspace');
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: /^回收站/ }).click();
  await row.click();
  await page.getByRole('button', { name: '永久删除…' }).click();
  await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused();
  await dialog.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(row).toHaveCount(0);
  const snapshot = await (await request.get(`/api/projects/${project.id}/snapshot`)).json();
  expect([...snapshot.entries, ...snapshot.trash]).toHaveLength(0);
});

test('画布拖动、调宽、平移缩放、搜索和位置复原', async ({ page, request }) => {
  const project = await workspace(page, request, '观察画布');
  await chooseFiles(page, csv);
  const card = page.locator('.card');
  await expect(card).toBeVisible();
  const id = await card.getAttribute('data-entry-id');
  const layout = async () => (await request.get(`/api/projects/${project.id}/layout?view=all`)).json();
  await expect.poll(async () => (await layout()).positions.length).toBe(1);
  const drag = async (locator: ReturnType<Page['locator']>, dx: number, dy: number, offset?: { x: number; y: number }) => {
    const rect = (await locator.boundingBox())!;
    await page.mouse.move(rect.x + (offset?.x ?? rect.width / 2), rect.y + (offset?.y ?? rect.height / 2));
    await page.mouse.down();
    await page.mouse.move(rect.x + (offset?.x ?? rect.width / 2) + dx, rect.y + (offset?.y ?? rect.height / 2) + dy, { steps: 8 });
    await page.mouse.up();
  };
  await drag(card.locator('.card-title'), 70, 20);
  await expect.poll(async () => (await layout()).positions[0]?.x).toBe(70);
  await drag(card.locator('[data-resize]'), 40, 0);
  await expect.poll(async () => (await layout()).positions[0]?.w).toBe(380);
  await drag(page.getByTestId('canvas'), 31, 27, { x: 18, y: 32 });
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await expect(page.locator('.zoom-level')).toHaveText('125%');
  await expect.poll(async () => (await layout()).viewport?.zoom).toBe(1.25);
  await page.reload();
  await expect(page.locator(`.card[data-entry-id="${id}"]`)).toHaveCSS('width', '380px');
  await expect(page.locator('.zoom-level')).toHaveText('125%');
  await page.getByRole('tab', { name: '列表' }).click();
  await page.getByRole('row', { name: /^延迟/ }).click();
  await page.getByRole('textbox', { name: '搜索' }).fill('不存在');
  await expect(page.locator('.inspector-empty')).toHaveText('未选择条目');
  await page.getByRole('textbox', { name: '搜索' }).blur();
  await page.keyboard.press('Backspace');
  await page.getByRole('button', { name: '清除搜索' }).click();
  await expect(page.getByRole('row', { name: /^延迟/ })).toBeVisible();
});

test('XLSX 编辑、切换工作表、快捷保存及历史恢复', async ({ page, request }) => {
  await workspace(page, request, '表格工作流');
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('测量').addRows([['方法', '延迟'], ['A', 7]]);
  workbook.addWorksheet('计算').getCell('A1').value = { formula: '5+4', result: 9 };
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  await chooseFiles(page, { name: '实验.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
  await expect(page.locator('.preview-table')).toContainText('方法');
  await page.locator('.card-title').dblclick();
  const bar = page.getByLabel('单元格内容');
  const cell = (row: number, col: number) => page.locator(`[data-row="${row}"][data-column="${col}"]`);
  await cell(1, 1).click();
  await bar.fill('24');
  await expect(bar).toBeFocused();
  await bar.press(`${mod}+s`);
  await expect(page.locator('.unsaved')).toHaveCount(0);
  await expect(cell(1, 1)).toHaveText('24');
  await cell(1, 1).dblclick();
  await page.locator('.grid-editor').fill('30');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.unsaved')).toBeVisible();
  await page.getByRole('button', { name: '计算', exact: true }).click();
  await expect(bar).toHaveValue('=5+4');
  await page.getByRole('button', { name: '测量', exact: true }).click();
  await expect(cell(1, 1)).toHaveText('30');
  await cell(1, 1).dblclick();
  await page.locator('.grid-editor').fill('31');
  await page.locator('.grid-editor').press(`${mod}+s`);
  await expect(cell(1, 1)).toHaveText('31');
  await expect(page.locator('.unsaved')).toHaveCount(0);
  await page.getByRole('button', { name: '版本记录' }).click();
  await expect(page.getByRole('menuitem', { name: /^第 3 版.*当前/ })).toBeVisible();
  await page.getByRole('menuitem', { name: /^第 1 版/ }).click();
  await expect(page.locator('.viewer-notice')).toContainText('只读');
  await expect(cell(1, 1)).toHaveText('7');
  await page.getByRole('button', { name: '与当前版本对比' }).click();
  await expect(page.locator('.compare-pane .grid-cell.changed')).toHaveText(['7', '31']);
  await page.getByRole('button', { name: '退出对比' }).click();
  await expect(cell(1, 1)).toHaveText('31');
  await page.getByRole('button', { name: '版本记录' }).click();
  await page.getByRole('menuitem', { name: /^第 1 版/ }).click();
  await page.getByRole('button', { name: '恢复此版本' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '恢复', exact: true }).click();
  await expect(cell(1, 1)).toHaveText('7');
  await expect(page.locator('.viewer-notice')).toHaveCount(0);
  await page.getByRole('button', { name: '版本记录' }).click();
  await expect(page.getByRole('menuitem', { name: /^第 4 版.*当前/ })).toBeVisible();
});

test('表格右键复制与清除作用于点击的单元格和行', async ({ page, request, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await workspace(page, request, '表格右键选区');
  await chooseFiles(page, csv);
  await page.locator('.card-title').dblclick();
  const grid = page.getByRole('grid');
  const cell = (row: number, column: number) => grid.locator(`[data-row="${row}"][data-column="${column}"]`);
  await cell(0, 0).click();
  await cell(1, 1).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^复制/ }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('12');
  await cell(0, 0).click();
  await cell(1, 1).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '清除内容' }).click();
  await expect(cell(0, 0)).toHaveText('批次');
  await expect(cell(1, 1)).toHaveText('');
  await cell(0, 0).click();
  await grid.locator('[data-header-row="2"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^剪切/ }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('AgentFS\t8');
  await expect(cell(2, 0)).toHaveText('');
  await expect(cell(2, 1)).toHaveText('');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.unsaved')).toHaveCount(0);
  await expect(cell(0, 0)).toHaveText('批次');
  await expect(cell(1, 1)).toHaveText('');
});

test('紧凑窗口保留工具栏操作，查看器焦点不进入工作区', async ({ page, request }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await workspace(page, request, '紧凑窗口');
  await chooseFiles(page, csv);
  const filter = page.getByRole('button', { name: '按文件类型筛选' });
  for (const name of ['表格', '图片', 'PDF', '文本', '其他文件']) {
    await filter.click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  }
  await expect(filter).toHaveClass(/active/);
  const toolbar = page.locator('.toolbar');
  const overflow = () => toolbar.evaluate(node => node.scrollWidth - node.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 961, height: 600 });
  expect(await overflow()).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 800, height: 600 });
  await page.getByRole('button', { name: '详情面板' }).click();
  await page.getByRole('tab', { name: '列表' }).click();
  await page.getByRole('row', { name: /^延迟/ }).dblclick();
  const grid = page.getByRole('grid');
  await expect(grid.locator('.grid-cell').first()).toBeVisible();
  await page.getByLabel('单元格内容').fill('8');
  await page.getByRole('button', { name: '版本记录' }).click();
  await page.getByRole('menuitem', { name: /^第 1 版.*当前/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.unsaved')).toBeVisible();
  await page.getByRole('button', { name: '返回', exact: true }).focus();
  for (let n = 0; n < 6; n++) {
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.sidebar, main'))).toBeFalsy();
  }
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveText(/放弃未保存的修改/);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByLabel('单元格内容')).toHaveValue('8');
});

test('文件可拖到指定分类，超出上限的文件夹不会被部分导入', async ({ page, request }) => {
  const project = await workspace(page, request, '拖入分类');
  const response = await request.post(`/api/projects/${project.id}/collections`, { data: { name: '目标分类' } });
  expect(response.ok()).toBeTruthy();
  const category = page.locator('.sidebar').getByRole('button', { name: /^目标分类/ });
  await category.evaluate(node => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['x,y\n1,2'], 'dropped.csv', { type: 'text/csv' }));
    dataTransfer.items.add(new File(['measurements'], 'dropped.log', { type: 'text/plain' }));
    node.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
  });
  await page.getByRole('dialog').getByRole('button', { name: '添加', exact: true }).click();
  await expect(category).toContainText('1');
  await category.click();
  await expect(page.locator('.card-title')).toHaveText('dropped');
  await expect(page.locator('.card .tile')).toHaveCount(2);

  await category.evaluate(node => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([], 'folder'));
    const files = Array.from({ length: 201 }, (_, index) => {
      const name = `log-${index}.txt`;
      return { name, isFile: true, isDirectory: false, file: (ready: (file: File) => void) => ready(new File(['log'], name)) };
    });
    const prototype = DataTransferItem.prototype;
    const original = Object.getOwnPropertyDescriptor(prototype, 'webkitGetAsEntry')!;
    Object.defineProperty(prototype, 'webkitGetAsEntry', { ...original, value: () => ({
      name: 'folder',
      isFile: false,
      isDirectory: true,
      createReader: () => ({ readEntries: (ready: (entries: typeof files) => void) => ready(files.splice(0, 100)) })
    }) });
    try {
      node.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
    } finally {
      Object.defineProperty(prototype, 'webkitGetAsEntry', original);
    }
  });
  await expect(page.locator('.toast')).toContainText('一次最多添加 200 个文件');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.card')).toHaveCount(1);
});

test('CLI 开窗时导入和更新，预览 PDF 并打开文本和其他文件', async ({ page, request }) => {
  const project = await workspace(page, request, '终端同步');
  const { home } = await (await request.get('/api/info')).json();
  const cli = (...args: string[]) => exec(process.execPath, ['cli/labcanvas.mjs', ...args, '--home', home, '--json']);
  await cli('import', 'examples/manifest.json', '-p', project.slug, '--dry-run');
  await expect(page.locator('.card')).toHaveCount(0);
  const imported = await cli('import', 'examples/manifest.json', '-p', project.slug);
  const result = JSON.parse(imported.stdout);
  await expect(page.locator('.card')).toHaveCount(result.entries.length);
  await cli('import', 'examples/manifest.json', '-p', project.slug);
  await expect(page.locator('.card')).toHaveCount(result.entries.length);
  await chooseFiles(page, [
    { name: '说明.pdf', mimeType: 'application/pdf', buffer: await readFile('tests/fixtures/sample.pdf') },
    { name: '记录.log', mimeType: 'text/plain', buffer: Buffer.from('original') },
    { name: '原始数据.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([12, 104, 220]) },
  ]);
  await page.getByRole('dialog').getByLabel('标题').fill('研究资料');
  await page.getByRole('dialog').getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('tab', { name: '列表' }).click();
  await page.getByRole('row', { name: /^研究资料/ }).dblclick();
  const pdf = page.locator('.pdf-page canvas');
  await expect.poll(async () => pdf.evaluate(node => (node as HTMLCanvasElement).width)).toBeGreaterThan(300);
  await expect.poll(async () => pdf.evaluate(node => {
    const data = (node as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 200, 200).data;
    return data.some((value, index) => index % 4 === 3 && value > 0);
  })).toBeTruthy();
  await page.getByRole('tab', { name: '记录.log' }).click();
  await page.getByRole('textbox', { name: '记录.log' }).fill('已复核');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.unsaved')).toHaveCount(0);
  await page.getByRole('tab', { name: '原始数据.bin' }).click();
  await expect(page.locator('.viewer-message')).toContainText('无法在应用内预览');
  const download = page.waitForEvent('download');
  await page.locator('.viewer-bar').getByRole('link', { name: '下载' }).click();
  expect(path.basename((await download).suggestedFilename())).toBe('原始数据.bin');
  await page.getByRole('tab', { name: '记录.log' }).click();
  await expect(page.getByRole('textbox', { name: '记录.log' })).toHaveValue('已复核');
});

test('大型表格可翻页查看全部行', async ({ page, request }) => {
  await workspace(page, request, '大表格');
  const buffer = Buffer.from(Array.from({ length: 20002 }, (_, index) => `值 ${index + 1}\n`).join(''));
  await chooseFiles(page, { name: '长表.csv', mimeType: 'text/csv', buffer });
  await page.locator('.card-title').dblclick();
  await expect(page.locator('.table-status')).toContainText('共 20002 行');
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.locator('[data-row="1"][data-column="0"]')).toHaveText('值 20002');
  await expect(page.locator('.cell-address')).toHaveText('A20001');
  await expect(page.getByRole('button', { name: '下一页' })).toBeDisabled();
  await page.getByRole('button', { name: '上一页' }).click();
  await expect(page.locator('[data-row="0"][data-column="0"]')).toHaveText('值 1');
});

test('新建表格、粘贴 TSV、撤销和导入 TIFF', async ({ page, request }) => {
  await workspace(page, request, '新建与多格式');
  await page.getByRole('button', { name: '新建表格', exact: true }).click();
  await page.getByRole('dialog').getByLabel('标题').fill('测量表');
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click();
  const grid = page.getByRole('grid');
  await expect(grid).toBeVisible();
  await grid.evaluate(element => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '样本\t延迟\nBaseline\t12');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  const sample = grid.locator('[data-row="1"][data-column="0"]');
  await expect(sample).toHaveText('Baseline');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(sample).toHaveText('');
  await page.getByRole('button', { name: '行', exact: true }).click();
  await page.getByRole('button', { name: '列', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.table-status')).toContainText('13 行 × 6 列');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  const tiff = await sharp({ create: { width: 320, height: 120, channels: 3, background: '#428c77' } }).tiff().toBuffer();
  await chooseFiles(page, { name: '成像.tiff', mimeType: 'image/tiff', buffer: tiff });
  await page.locator('.card-title', { hasText: '成像' }).dblclick();
  await expect(page.locator('.image-stage img')).toBeVisible();
  await expect.poll(() => page.locator('.image-stage img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(320);
  await page.getByRole('button', { name: '放大', exact: true }).last().click();
  await expect(page.locator('.image-view .zoom-level')).toHaveText('125%');
});

test('分开导入、框选合并、拖到分类，再拆分并撤销备注编辑', async ({ page, request }) => {
  const project = await workspace(page, request, '组合管理');
  await chooseFiles(page, [csv, { name: 'result.svg', mimeType: 'image/svg+xml', buffer: await readFile(figure) }]);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: '每个文件各自成为一个条目' }).check();
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.locator('.card')).toHaveCount(2);
  await page.getByRole('button', { name: '缩放以显示全部' }).click();
  const canvas = (await page.getByTestId('canvas').boundingBox())!;
  await page.mouse.move(canvas.x + 12, canvas.y + 15);
  await page.mouse.click(canvas.x + 12, canvas.y + 15);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width - 15, canvas.y + canvas.height - 56, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(page.locator('.card.selected')).toHaveCount(2);
  await page.getByRole('button', { name: '合并为一个条目', exact: true }).click();
  await expect(page.locator('.card')).toHaveCount(1);
  await expect(page.locator('.tile')).toHaveCount(2);
  const add = await request.post(`/api/projects/${project.id}/collections`, { data: { name: 'Baseline' } });
  const target = page.locator('.sidebar').getByRole('button', { name: /^Baseline/ });
  await expect(target).toBeVisible();
  await page.getByRole('button', { name: '缩放以显示全部' }).click();
  const card = (await page.locator('.card-title').boundingBox())!;
  const drop = (await target.boundingBox())!;
  await page.mouse.move(card.x + 15, card.y + 8);
  await page.mouse.down();
  await page.mouse.move(drop.x + drop.width / 2, drop.y + drop.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('.chip-label', { hasText: 'Baseline' })).toBeVisible();
  await expect(target).toContainText('1');
  await expect(add.ok()).toBeTruthy();
  const note = page.getByRole('textbox', { name: '备注', exact: true });
  await note.fill('撤销的草稿');
  await note.press('Escape');
  await expect(note).toHaveValue('');
  await page.getByRole('button', { name: 'result.svg 的操作' }).click();
  await page.getByRole('menuitem', { name: '拆分为独立条目' }).click();
  await expect(page.locator('.card')).toHaveCount(2);
  await expect(target).toContainText('2');
});
