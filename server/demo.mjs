// Builds a small sample project so the interface can be tried without real experiment data.
// All numbers are synthetic.
import { stringify } from 'csv-stringify/sync';

const COLORS = ['#8e8e93', '#2f6fde'];

function frame(title, width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">
<rect width="100%" height="100%" fill="#fff"/>
<text x="56" y="30" font-size="15" font-weight="600" fill="#1d1d1f">${title}</text>
${body}</svg>`;
}

function axes(width, height, max, unit) {
  const lines = [];
  for (let i = 0; i <= 4; i++) {
    const y = height - 48 - (i * (height - 104)) / 4;
    lines.push(`<line x1="56" x2="${width - 24}" y1="${y}" y2="${y}" stroke="#e5e5ea"/>`);
    lines.push(`<text x="48" y="${y + 4}" font-size="10" text-anchor="end" fill="#6e6e73">${Math.round((max * i) / 4)}</text>`);
  }
  lines.push(`<text x="56" y="48" font-size="10" fill="#6e6e73">${unit}</text>`);
  return lines.join('\n');
}

function legend(names, x, y) {
  return names.map((name, i) =>
    `<rect x="${x + i * 96}" y="${y - 8}" width="9" height="9" fill="${COLORS[i]}"/><text x="${x + 14 + i * 96}" y="${y}" font-size="10" fill="#3a3a3c">${name}</text>`
  ).join('');
}

function barChart(title, unit, labels, series, names) {
  const width = 640, height = 400;
  const max = Math.ceil(Math.max(...series.flat()) / 50) * 50;
  const band = (width - 80) / labels.length;
  const scale = value => ((height - 104) * value) / max;
  const bars = labels.map((label, i) => {
    const x = 56 + i * band + band * 0.2;
    const w = (band * 0.6) / series.length;
    return series.map((values, s) =>
      `<rect x="${x + s * w}" y="${height - 48 - scale(values[i])}" width="${w - 2}" height="${scale(values[i])}" fill="${COLORS[s]}"/>`
    ).join('') + `<text x="${56 + i * band + band / 2}" y="${height - 30}" font-size="10" text-anchor="middle" fill="#3a3a3c">${label}</text>`;
  }).join('\n');
  return frame(title, width, height, `${axes(width, height, max, unit)}\n${bars}\n${legend(names, 56, height - 8)}`);
}

function lineChart(title, unit, labels, series, names) {
  const width = 640, height = 400;
  const max = Math.ceil(Math.max(...series.flat()) / 20) * 20;
  const step = (width - 110) / (labels.length - 1);
  const point = (value, i) => `${70 + i * step},${height - 48 - ((height - 104) * value) / max}`;
  const lines = series.map((values, s) =>
    `<polyline fill="none" stroke="${COLORS[s]}" stroke-width="2" points="${values.map(point).join(' ')}"/>` +
    values.map((value, i) => `<circle cx="${point(value, i).split(',')[0]}" cy="${point(value, i).split(',')[1]}" r="3" fill="${COLORS[s]}"/>`).join('')
  ).join('\n');
  const ticks = labels.map((label, i) => `<text x="${70 + i * step}" y="${height - 30}" font-size="10" text-anchor="middle" fill="#3a3a3c">${label}</text>`).join('');
  return frame(title, width, height, `${axes(width, height, max, unit)}\n${lines}\n${ticks}\n${legend(names, 56, height - 8)}`);
}

const csv = rows => Buffer.from(stringify(rows));

export async function seedDemo(store, { name = 'AgentFS 示例' } = {}) {
  const project = store.createProject({ name });
  const workloads = ['Seq. read', 'Rand. read', 'Seq. write', 'Rand. write', 'Metadata', 'Mixed'];
  const baseline = [183.2, 96.4, 142.8, 71.6, 115.3, 102.1];
  const agentfs = [296.7, 181.2, 219.3, 130.9, 267.4, 189.6];
  const clients = [1, 4, 8, 16, 32, 64];
  const p99Base = [8.1, 9.6, 13.4, 24.8, 47.2, 104.5];
  const p99Ours = [6.2, 6.8, 7.9, 9.7, 14.1, 23.6];
  const day = '2026-11-10';

  await store.createEntry(project.id, {
    title: '吞吐量 · Baseline 对比 AgentFS',
    date: day,
    note: '示例数据，数值为模拟。6 类负载，各 5 次取平均。',
    collections: ['实验日期/2026-11-10', '实验目的/自己方法', '实验目的/Baseline', '测试模块/读写路径'],
    files: [
      { name: 'throughput.csv', buffer: csv([['Workload', 'Baseline (k ops/s)', 'AgentFS (k ops/s)', 'Speedup', 'Trials'], ...workloads.map((w, i) => [w, baseline[i], agentfs[i], (agentfs[i] / baseline[i]).toFixed(2), 5])]) },
      { name: 'throughput.svg', buffer: Buffer.from(barChart('Throughput', 'k ops/s', workloads, [baseline, agentfs], ['Baseline', 'AgentFS'])) }
    ]
  });
  await store.createEntry(project.id, {
    title: '尾延迟 · 并发度',
    date: day,
    note: '示例数据，数值为模拟。',
    collections: ['实验日期/2026-11-10', '实验目的/自己方法', '测试模块/并发'],
    files: [
      { name: 'latency_p99.csv', buffer: csv([['Clients', 'Baseline p99 (ms)', 'AgentFS p99 (ms)'], ...clients.map((c, i) => [c, p99Base[i], p99Ours[i]])]) },
      { name: 'latency_p99.svg', buffer: Buffer.from(lineChart('Tail latency (p99)', 'ms', clients, [p99Base, p99Ours], ['Baseline', 'AgentFS'])) },
      { name: 'latency_speedup.svg', buffer: Buffer.from(barChart('p99 reduction', '%', clients, [p99Base.map((b, i) => Math.round((1 - p99Ours[i] / b) * 100))], ['AgentFS'])) }
    ]
  });
  await store.createEntry(project.id, {
    title: '缓存与预取消融',
    date: '2026-11-12',
    collections: ['实验日期/2026-11-12', '实验目的/自己方法', '测试模块/缓存'],
    files: [{ name: 'ablation.csv', buffer: csv([['Configuration', 'Throughput (k ops/s)', 'p99 (ms)', 'Memory (MB)'], ['Baseline', 115.3, 28.9, 192], ['+ Metadata cache', 189.4, 16.2, 214], ['+ Prefetch', 231.8, 11.4, 236], ['Full AgentFS', 267.4, 8.6, 248]]) }]
  });
  await store.createEntry(project.id, {
    title: '扩展性测试',
    date: '2026-11-12',
    collections: ['实验日期/2026-11-12', '实验目的/Baseline', '测试模块/并发'],
    files: [{ name: 'scaling.csv', buffer: csv([['Workers', 'Throughput (k ops/s)', 'CPU (%)', 'Trials'], [1, 42.1, 12, 5], [2, 81.4, 23, 5], [4, 151.7, 44, 5], [8, 267.4, 81, 5], [16, 308.2, 96, 5]]) }]
  });
  await store.createEntry(project.id, {
    title: '运行配置与日志',
    date: '2026-11-12',
    collections: ['实验日期/2026-11-12'],
    files: [
      { name: 'config.yaml', buffer: Buffer.from('workload: mixed\nclients: 32\nduration_s: 120\ncache:\n  metadata: true\n  prefetch: true\nseed: 20261112\n') },
      { name: 'run.log', buffer: Buffer.from('[00:00:00] start benchmark workload=mixed clients=32\n[00:00:30] warmup done\n[00:02:30] throughput=189.6k ops/s p99=14.1ms\n[00:02:31] finished, results written to results/\n') }
    ]
  });
  return store.project(project.id);
}
