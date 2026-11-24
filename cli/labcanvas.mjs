#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { assert, AppError } from '../server/errors.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const HELP = `LabCanvas ${VERSION}

用法
  labcanvas add FILE... -p PROJECT [-c 分类路径]... [选项]    导入文件并归类
  labcanvas import MANIFEST.json [-p PROJECT]                 按清单批量导入
  labcanvas attach ENTRY FILE... [--replace]                  向已有条目追加文件
  labcanvas list -p PROJECT [-c 分类路径] [-q 关键词] [--trash]
  labcanvas show ENTRY
  labcanvas edit ENTRY [-t 标题] [-d 日期] [-n 备注] [-f 属性=值]...
  labcanvas search 关键词 -p PROJECT                          搜索标题、备注、属性、文件名和文件内容
  labcanvas classify ENTRY... -c 分类路径                     加入分类（只添加引用）
  labcanvas unclassify ENTRY... -c 分类路径                   从分类移除（数据保留）
  labcanvas trash ENTRY...      移到回收站
  labcanvas restore ENTRY...    从回收站恢复
  labcanvas delete ENTRY... --yes                             永久删除
  labcanvas export FILE_ID -o 路径                            导出文件
  labcanvas projects
  labcanvas project create NAME [--slug SLUG] | rename PROJECT NAME | delete PROJECT --yes
  labcanvas collections -p PROJECT
  labcanvas collection create|delete PATH -p PROJECT
  labcanvas collection rename PATH NAME -p PROJECT
  labcanvas backup 目录 | doctor | reindex | demo | serve [--port 4317]

add 的选项
  -p, --project     项目标识、名称或 ID；也可用环境变量 LABCANVAS_PROJECT
  -c, --collection  分类路径，如 "实验目的/Baseline"；可重复；不存在时自动创建
  -t, --title       条目标题，默认取表格（或首个文件）的文件名
  -d, --date        实验日期 YYYY-MM-DD，默认今天
  -n, --note        备注
  -f, --field       属性，如 -f lr=0.001 -f model=resnet50；可重复；值留空则删除该属性
  -k, --key         稳定标识。同一项目内再次使用相同 key 会原地更新该条目：
                    同名文件内容变化则存为新版本，新文件追加，不产生重复条目
      --separate    每个文件各自成为一个条目（默认：所有文件组成一个条目）
      --no-link     不自动把图片/PDF 关联到条目内唯一的表格
      --dry-run     只检查，不写入

通用选项
      --json        输出 JSON（标准输出不是终端时默认即为 JSON）
      --home DIR    资料库目录，默认 ~/.labcanvas，也可用 LABCANVAS_HOME

多个文件默认组成一个条目，例如一张结果表和由它画出的图：
  labcanvas add results.csv fig1.png fig2.png -p agentfs \\
    -c "实验日期/2026-11-19" -c "实验目的/Baseline" -t "缓存消融" -k cache-ablation

错误以非零退出码结束；JSON 模式下 stderr 为 {"error":{"code","message"}}。
`;

const options = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' },
  home: { type: 'string' },
  project: { type: 'string', short: 'p' },
  collection: { type: 'string', short: 'c', multiple: true },
  title: { type: 'string', short: 't' },
  date: { type: 'string', short: 'd' },
  note: { type: 'string', short: 'n' },
  field: { type: 'string', short: 'f', multiple: true },
  key: { type: 'string', short: 'k' },
  query: { type: 'string', short: 'q' },
  output: { type: 'string', short: 'o' },
  slug: { type: 'string' },
  port: { type: 'string' },
  separate: { type: 'boolean' },
  replace: { type: 'boolean' },
  trash: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  'no-link': { type: 'boolean' },
  'dry-run': { type: 'boolean' }
};

let json = !process.stdout.isTTY;
let store;

const size = bytes => (bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`);

function printEntry(entry, paths) {
  console.log(`${entry.id}  ${entry.date}  ${entry.title}${entry.deleted_at ? '  [回收站]' : ''}`);
  for (const file of entry.files) console.log(`    ${file.id}  ${file.name}  ${size(file.size)}  v${file.version}`);
  const names = entry.collection_ids.map(id => paths.get(id)).filter(Boolean);
  if (names.length) console.log(`    分类: ${names.join(', ')}`);
  if (entry.fields?.length) console.log(`    属性: ${entry.fields.map(field => `${field.name}=${field.value}`).join(', ')}`);
  if (entry.note) console.log(`    备注: ${entry.note.split('\n')[0]}`);
}

/** Prints JSON for agents and scripts, or a short human summary on a terminal. */
function output(result, human) {
  if (json) console.log(JSON.stringify(result, null, 2));
  else human(result);
}

async function main() {
  const { values: flags, positionals } = parseArgs({ allowPositionals: true, options });
  if (flags.json) json = true;
  if (flags.version) return console.log(VERSION);
  const [command, ...args] = positionals;
  if (flags.help || !command) return console.log(HELP);

  if (command === 'serve') {
    const { startServer } = await import('../server/index.mjs');
    const running = await startServer({ home: flags.home, port: Number(flags.port || 4317) });
    console.log(`LabCanvas ${VERSION} · ${running.url}`);
    const exit = () => running.stop().then(() => process.exit(0));
    process.on('SIGINT', exit);
    process.on('SIGTERM', exit);
    return;
  }

  store = new Store(flags.home);
  const projectRef = () => {
    const ref = flags.project || process.env.LABCANVAS_PROJECT;
    assert(ref, '请用 -p 指定项目（labcanvas projects 查看已有项目）', 400, 'PROJECT_REQUIRED');
    return ref;
  };
  const need = (value, message) => {
    assert(value !== undefined && value !== '' && (!Array.isArray(value) || value.length), message, 400, 'USAGE');
    return value;
  };
  const pathsOf = projectId => new Map(store.collections(projectId).map(c => [c.id, c.path]));
  const projectOfEntries = ids => {
    const projects = new Set(ids.map(id => store.entry(id).project_id));
    assert(projects.size === 1, '这些条目不属于同一个项目');
    return [...projects][0];
  };
  const fieldsOf = () => {
    if (!flags.field?.length) return undefined;
    return Object.fromEntries(flags.field.map(pair => {
      const at = pair.indexOf('=');
      assert(at > 0, `属性须写成 名称=值：${pair}`, 400, 'USAGE');
      return [pair.slice(0, at).trim(), pair.slice(at + 1)];
    }));
  };
  const confirmed = what => assert(flags.yes, `${what}不可恢复，确认请加 --yes`, 400, 'CONFIRMATION_REQUIRED');

  switch (command) {
    case 'add': {
      const files = need(args, '请提供要导入的文件').map(file => ({ path: path.resolve(file) }));
      const spec = { title: flags.title, date: flags.date, note: flags.note, collections: flags.collection ?? [], fields: fieldsOf(), link: !flags['no-link'] };
      const run = { dryRun: !!flags['dry-run'] };
      let specs;
      if (flags.separate) {
        assert(!flags.title || files.length === 1, '--separate 导入多个文件时不能指定同一个标题', 400, 'USAGE');
        specs = files.map(file => {
          const key = flags.key ? (files.length > 1 ? `${flags.key}:${path.basename(file.path)}` : flags.key) : undefined;
          return { ...spec, key, files: [file] };
        });
      } else {
        specs = [{ ...spec, key: flags.key, files }];
      }
      const entries = await store.createEntries(projectRef(), specs, run);
      return output({ entries }, () => {
        for (const entry of entries) {
          if (entry.dry_run) console.log(`检查通过：将${entry.status === 'created' ? '新建' : '更新'}条目，${entry.files} 个文件`);
          else console.log(`${entry.status === 'created' ? '已添加' : '已更新'}  ${entry.id}  ${entry.title}  (${entry.files.length} 个文件)`);
        }
      });
    }
    case 'import': {
      const file = path.resolve(need(args[0], '请提供清单文件'));
      const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
      assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest), '清单须为 JSON 对象', 422, 'INVALID_MANIFEST');
      const project = flags.project || manifest.project || process.env.LABCANVAS_PROJECT;
      assert(project, '请在清单中写明 project，或用 -p 指定', 400, 'PROJECT_REQUIRED');
      assert(Array.isArray(manifest.entries) && manifest.entries.length > 0, '清单须包含 entries 数组', 422, 'INVALID_MANIFEST');
      const base = path.dirname(file);
      const specs = manifest.entries.map((entry, index) => {
        assert(entry && Array.isArray(entry.files ?? []), `entries[${index}].files 须为数组`, 422, 'INVALID_MANIFEST');
        return {
          ...entry,
          files: (entry.files ?? []).map(item => {
            const spec = typeof item === 'string' ? { path: item } : item;
            assert(typeof spec?.path === 'string' && spec.path, `entries[${index}] 中的文件缺少 path`, 422, 'INVALID_MANIFEST');
            return { ...spec, path: path.resolve(base, spec.path) };
          })
        };
      });
      const entries = await store.createEntries(project, specs, { dryRun: !!flags['dry-run'] });
      return output({ dry_run: !!flags['dry-run'], entries }, () => {
        if (flags['dry-run']) console.log(`检查通过：${specs.length} 个条目`);
        else for (const entry of entries) console.log(`${entry.status === 'created' ? '已添加' : '已更新'}  ${entry.id}  ${entry.title}`);
      });
    }
    case 'attach': {
      const [entryId, ...files] = args;
      need(files, '用法：labcanvas attach ENTRY FILE...');
      const result = await store.addFiles(entryId, files.map(file => ({ path: path.resolve(file) })), { upsert: !!flags.replace });
      return output(result, () => result.files.forEach(file => console.log(`${file.status}  ${file.id}  ${file.name}  v${file.version}`)));
    }
    case 'list': {
      const project = store.project(projectRef());
      const entries = store.entries(project.id, { collection: flags.collection?.[0], query: flags.query, trash: !!flags.trash });
      const paths = pathsOf(project.id);
      return output(entries, () => {
        if (!entries.length) console.log('没有条目');
        entries.forEach(entry => printEntry(entry, paths));
      });
    }
    case 'search': {
      const project = store.project(projectRef());
      const query = need(args.join(' ') || flags.query, '请提供关键词');
      await store.reindex();
      const hits = store.search(project.id, query).map(hit => ({ ...store.entry(hit.entry_id), snippet: hit.snippet })).filter(entry => !entry.deleted_at || flags.trash);
      const paths = pathsOf(project.id);
      return output(hits, () => {
        if (!hits.length) console.log('没有匹配的条目');
        for (const entry of hits) {
          printEntry(entry, paths);
          console.log(`    匹配: ${entry.snippet}`);
        }
      });
    }
    case 'reindex': {
      const result = await store.reindex();
      return output(result, () => console.log(`已为 ${result.indexed} 个文件建立内容索引`));
    }
    case 'show': {
      const entry = store.entry(need(args[0], '请提供条目 ID'));
      return output(entry, () => printEntry(entry, pathsOf(entry.project_id)));
    }
    case 'edit': {
      const entry = store.updateEntry(need(args[0], '请提供条目 ID'), { title: flags.title, date: flags.date, note: flags.note, fields: fieldsOf() });
      return output(entry, () => printEntry(entry, pathsOf(entry.project_id)));
    }
    case 'classify':
    case 'unclassify': {
      need(args, '请提供条目 ID');
      const collections = need(flags.collection, '请用 -c 指定分类');
      const project = projectOfEntries(args);
      const results = collections.map(ref => store.setMembership(project, args, ref, command === 'classify'));
      return output(results, () => console.log(command === 'classify' ? `已加入分类：${collections.join(', ')}` : `已从分类移除：${collections.join(', ')}（数据保留）`));
    }
    case 'trash':
    case 'restore': {
      need(args, '请提供条目 ID');
      const result = store.trash(projectOfEntries(args), args, command === 'trash');
      return output(result, () => console.log(command === 'trash' ? `已移到回收站：${args.length} 个条目` : `已恢复：${args.length} 个条目`));
    }
    case 'delete': {
      need(args, '请提供条目 ID');
      confirmed('永久删除');
      const result = await store.purge(projectOfEntries(args), args);
      return output(result, () => console.log(`已永久删除：${args.length} 个条目`));
    }
    case 'export': {
      const version = store.version(need(args[0], '请提供文件 ID'));
      let target = path.resolve(need(flags.output, '请用 -o 指定导出路径'));
      if ((await fs.stat(target).catch(() => null))?.isDirectory()) target = path.join(target, version.name);
      await fs.copyFile(version.path, target, fs.constants.COPYFILE_EXCL).catch(error => {
        if (error.code === 'EEXIST') throw new AppError(`目标已存在：${target}`, 409, 'CONFLICT');
        throw error;
      });
      return output({ exported: target, file_id: args[0], version: version.number }, () => console.log(target));
    }
    case 'projects': {
      const projects = store.projects();
      return output(projects, () => {
        if (!projects.length) console.log('还没有项目。labcanvas project create NAME');
        projects.forEach(p => console.log(`${p.slug}  ${p.name}  (${p.entry_count} 个条目)`));
      });
    }
    case 'project': {
      const [action, first, second] = args;
      if (action === 'create') {
        const project = store.createProject({ name: need(first, '请提供项目名称'), slug: flags.slug });
        return output(project, () => console.log(`已创建项目  ${project.slug}  ${project.name}`));
      }
      if (action === 'rename') {
        const project = store.updateProject(need(first, '请提供项目'), { name: need(second, '请提供新名称') });
        return output(project, () => console.log(`已重命名  ${project.slug}  ${project.name}`));
      }
      if (action === 'delete') {
        confirmed('删除项目及其全部数据');
        const result = await store.deleteProject(need(first, '请提供项目'));
        return output(result, () => console.log('已删除项目'));
      }
      break;
    }
    case 'collections': {
      const collections = store.collections(projectRef());
      return output(collections, () => {
        if (!collections.length) console.log('没有分类');
        collections.forEach(c => console.log(`${c.id}  ${c.path}  (${c.entry_count})`));
      });
    }
    case 'collection': {
      const [action, ref, name] = args;
      const project = store.project(projectRef());
      if (action === 'create') {
        const collection = store.resolveCollection(project.id, need(ref, '请提供分类路径'), { create: true });
        return output(collection, () => console.log(`${collection.id}  ${ref}`));
      }
      if (action === 'rename') {
        const collection = store.updateCollection(store.resolveCollection(project.id, need(ref, '请提供分类路径')).id, { name: need(name, '请提供新名称') });
        return output(collection, () => console.log(`已重命名为 ${collection.name}`));
      }
      if (action === 'delete') {
        const result = store.deleteCollection(store.resolveCollection(project.id, need(ref, '请提供分类路径')).id);
        return output(result, () => console.log('已删除分类（条目数据保留）'));
      }
      break;
    }
    case 'demo': {
      const { seedDemo } = await import('../server/demo.mjs');
      const project = await seedDemo(store);
      return output(project, () => console.log(`已创建示例项目  ${project.slug}`));
    }
    case 'backup': {
      const { backup: target } = await store.backup(need(args[0] ?? flags.output, '请提供备份目录'), { lock: true });
      return output({ backup: target }, () => console.log(target));
    }
    case 'doctor': {
      const report = await store.doctor();
      if (!report.ok) process.exitCode = 1;
      return output(report, () => console.log(report.ok ? `资料库正常  ${report.home}` : `发现问题：integrity=${report.integrity}，缺失文件 ${report.missing_files.length} 个`));
    }
  }
  throw new AppError(`未知命令：${positionals.join(' ')}。运行 labcanvas --help 查看用法`, 400, 'USAGE');
}

try {
  await main();
} catch (error) {
  const code = error.code && typeof error.code === 'string' ? error.code : 'ERROR';
  if (json) console.error(JSON.stringify({ error: { code, message: error.message } }));
  else console.error(`错误：${error.message}`);
  process.exitCode = process.exitCode || 1;
} finally {
  if (process.argv[2] !== 'serve') store?.close();
}
