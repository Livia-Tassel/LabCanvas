import path from 'node:path';
import { promises as fs } from 'node:fs';
import ExcelJS from 'exceljs';
import sharp from 'sharp';

function plot(title, subtitle, series, labels, unit = 'k ops/s', mode = 'bar') {
  const w = 780, h = 450, left = 76, top = 90, cw = 660, ch = 270;
  const max = Math.ceil(Math.max(...series.flatMap(s => s.values)) / 50) * 50;
  const colors = ['#a7b0b9', '#477b65', '#89a7c6'];
  let body = `<rect width="${w}" height="${h}" fill="#f4f5f2"/><text x="36" y="38" font-size="23" font-weight="600">${title}</text><text x="36" y="62" fill="#758078" font-size="13">${subtitle} · SIMULATED DATA</text>`;
  for (let n = 0; n <= 4; n++) {
    const y = top + ch - n * ch / 4;
    body += `<path d="M${left} ${y}H${left + cw}" stroke="#dce1db"/><text x="${left - 12}" y="${y + 4}" text-anchor="end" fill="#7b837d" font-size="12">${Math.round(max * n / 4)}</text>`;
  }
  body += `<text x="${left}" y="${top - 14}" fill="#7b837d" font-size="11">${unit}</text>`;
  const step = cw / labels.length;
  labels.forEach((label, i) => { body += `<text x="${left + step * (i + .5)}" y="${top + ch + 23}" text-anchor="middle" fill="#657068" font-size="12">${label}</text>`; });
  series.forEach((s, si) => {
    if (mode === 'line') {
      const points = s.values.map((v, i) => `${left + step * (i + .5)},${top + ch - v / max * ch}`);
      body += `<polyline points="${points.join(' ')}" fill="none" stroke="${colors[si]}" stroke-width="3"/>`;
      s.values.forEach((v, i) => { body += `<circle cx="${left + step * (i + .5)}" cy="${top + ch - v / max * ch}" r="4" fill="${colors[si]}"/>`; });
    } else s.values.forEach((v, i) => {
      const bw = step / (series.length + 1.5), x = left + step * i + step * .15 + si * (bw + 3), bh = v / max * ch;
      body += `<rect x="${x}" y="${top + ch - bh}" width="${bw}" height="${bh}" rx="2" fill="${colors[si]}"/>`;
    });
    body += `<rect x="${left + si * 175}" y="415" width="10" height="10" rx="2" fill="${colors[si]}"/><text x="${left + si * 175 + 18}" y="424" font-size="12" fill="#657068">${s.name}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" font-family="Arial, sans-serif" fill="#293a30">${body}</svg>`;
}

export async function seedDemo(store, { force = false } = {}) {
  const old = store.projects().find(p => p.slug === 'agentfs-demo');
  if (old) return { project: old, existing: true };
  if (!force && store.one("SELECT value FROM meta WHERE key='demo_initialized'")) return null;
  const dir = path.join(store.home, 'examples', 'agentfs'); await fs.mkdir(dir, { recursive: true });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('吞吐量');
  sheet.addRows([
    ['Workload', 'Baseline (k ops/s)', 'AgentFS (k ops/s)', 'Speedup', 'Trials'],
    ['Sequential read', 183.2, 296.7, 1.62, 5], ['Random read', 96.4, 181.2, 1.88, 5],
    ['Sequential write', 142.8, 219.3, 1.54, 5], ['Random write', 71.6, 130.9, 1.83, 5],
    ['Metadata', 115.3, 267.4, 2.32, 5], ['Mixed R/W', 102.1, 189.6, 1.86, 5]
  ]);
  sheet.columns.forEach(c => c.width = 24);
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF477B65' } };
  workbook.addWorksheet('实验说明').addRows([['说明', '内容'], ['数据性质', '模拟数据，仅用于功能验证'], ['环境', 'Synthetic workload / 5 trials'], ['日期', '2026-11-10']]);
  await workbook.xlsx.writeFile(path.join(dir, 'throughput.xlsx'));
  await fs.writeFile(path.join(dir, 'latency.csv'), 'Concurrency,Baseline p50 (ms),AgentFS p50 (ms),Baseline p99 (ms),AgentFS p99 (ms)\n1,2.8,1.9,8.2,4.1\n4,3.2,2.1,10.5,4.9\n8,4.1,2.5,15.7,6.2\n16,6.8,3.4,28.9,8.6\n32,11.2,5.1,52.6,14.3\n64,23.5,8.7,118.4,27.1\n');
  await fs.writeFile(path.join(dir, 'ablation.csv'), 'Configuration,Throughput (k ops/s),p99 (ms),Memory (MB)\nBaseline,115.3,28.9,192\n+ Metadata cache,189.7,16.2,214\n+ Prefetch,231.8,11.4,236\nFull AgentFS,267.4,8.6,248\n');
  await fs.writeFile(path.join(dir, 'scaling.csv'), 'Workers,Throughput (k ops/s),CPU (%),Trials\n1,42.1,12,5\n2,81.4,23,5\n4,151.7,44,5\n8,267.4,81,5\n16,308.2,96,5\n');
  await fs.writeFile(path.join(dir, 'notes.md'), '# 实验记录\n\n本项目中的数值均为模拟数据，用于验证 LabCanvas 功能。\n\n## 本轮检查\n\n- 对比 Baseline 与 AgentFS 的吞吐量和尾延迟。\n- 按模块与实验日期组织同一批结果。\n- 对缓存和预取进行消融测试。\n\n## 后续实验\n\n增加重复次数；记录硬件与配置；检查结果稳定性。\n');
  await fs.writeFile(path.join(dir, 'run.log'), '[SIMULATED DATA — NOT REAL EXPERIMENT RESULTS]\n2026-11-10T09:00:00+08:00 INFO run=demo-001 workload=synthetic trials=5\n2026-11-10T09:00:01+08:00 INFO baseline started\n2026-11-10T09:01:32+08:00 INFO baseline completed\n2026-11-10T09:01:33+08:00 INFO agentfs started\n2026-11-10T09:03:24+08:00 INFO agentfs completed\n2026-11-10T09:03:25+08:00 INFO results exported\n');
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ simulated: true, workload: 'synthetic', trials: 5, workers: [1, 2, 4, 8, 16], seed: 42 }, null, 2));
  await sharp(Buffer.from(plot('Throughput comparison', 'Baseline vs. AgentFS / 5 trials', [
    { name: 'Baseline', values: [183.2, 96.4, 142.8, 71.6, 115.3, 102.1] }, { name: 'AgentFS', values: [296.7, 181.2, 219.3, 130.9, 267.4, 189.6] }
  ], ['Seq. R', 'Rand. R', 'Seq. W', 'Rand. W', 'Metadata', 'Mixed']))).png().toFile(path.join(dir, 'throughput.png'));
  await sharp(Buffer.from(plot('Tail latency (p99)', 'Concurrent clients / lower is better', [
    { name: 'Baseline', values: [8.2, 10.5, 15.7, 28.9, 52.6, 118.4] }, { name: 'AgentFS', values: [4.1, 4.9, 6.2, 8.6, 14.3, 27.1] }
  ], ['1', '4', '8', '16', '32', '64'], 'ms', 'line'))).png().toFile(path.join(dir, 'latency.png'));
  const manifest = {
    version: 1, import_key: 'agentfs-simulated-v1',
    run: { title: 'Baseline / AgentFS 对比 · 模拟运行', occurred_at: '2026-11-10T09:00:00+08:00', command: 'python benchmark.py --config config.json --trials 5  # simulated' },
    items: [
      { key: 'throughput', path: 'throughput.xlsx', title: '吞吐量对比', description: '模拟数据 · 6 类工作负载，每组 5 次重复。', role: 'result' },
      { key: 'throughput-plot', path: 'throughput.png', title: '吞吐量对比图', role: 'result', derived_from: ['throughput'] },
      { key: 'latency', path: 'latency.csv', title: '并发延迟', description: '模拟数据 · 不同并发度下的 p50 / p99 延迟。', role: 'result' },
      { key: 'latency-plot', path: 'latency.png', title: '尾延迟曲线', role: 'result', derived_from: ['latency'] },
      { key: 'ablation', path: 'ablation.csv', title: '缓存与预取消融', role: 'result', collections: ['模块测试/缓存', '实验日期/2026-11-10'] },
      { key: 'scaling', path: 'scaling.csv', title: '扩展性测试', role: 'result', collections: ['模块测试/并发', '实验日期/2026-11-10'] },
      { key: 'notes', path: 'notes.md', title: '实验笔记', role: 'result', collections: ['实验日期/2026-11-10'] },
      { key: 'log', path: 'run.log', title: '运行日志', role: 'supporting' },
      { key: 'config', path: 'config.json', title: '实验配置', role: 'supporting' }
    ],
    groups: [
      { key: 'throughput-group', title: '吞吐量 · Baseline vs AgentFS', members: ['throughput', 'throughput-plot'], primary: 'throughput-plot', collections: ['基准对比', '实验日期/2026-11-10'] },
      { key: 'latency-group', title: '延迟 · 并发度对比', members: ['latency', 'latency-plot'], primary: 'latency-plot', collections: ['基准对比', '模块测试/并发', '实验日期/2026-11-10'] }
    ]
  };
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const p = store.createProject({ name: 'AgentFS', slug: 'agentfs-demo', description: '模拟实验数据，仅用于功能验证。', is_demo: true });
  const imported = await store.importManifest(p.id, manifest, { baseDir: dir });
  store.exec("INSERT OR REPLACE INTO meta VALUES ('demo_initialized','1')");
  return { project: p, import: imported, example_directory: dir };
}
