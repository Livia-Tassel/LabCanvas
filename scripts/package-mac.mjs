import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);
if (process.platform !== 'darwin') throw new Error('macOS 打包需要在 macOS 上运行');
// Documents may be managed by a file provider which reintroduces FinderInfo while signing.
// Sign outside that directory, then distribute the immutable disk image.
const staging = path.join(os.homedir(), 'Library', 'Caches', 'LabCanvas', 'releases', '1.0.0');
const app = path.join(staging, 'LabCanvas.app');
await mkdir(staging, { recursive: true }); await rm(app, { recursive: true, force: true });
await exec('ditto', ['--norsrc', '--noextattr', path.resolve('release/mac-arm64/LabCanvas.app'), app]);
await exec('xattr', ['-cr', app]);
await exec('codesign', ['--force', '--deep', '--sign', '-', app]);
await exec('codesign', ['--verify', '--deep', '--strict', app]);
await rm(path.join(staging, 'Applications'), { force: true }); await symlink('/Applications', path.join(staging, 'Applications'));
const dmg = path.resolve('release/LabCanvas-1.0.0-arm64.dmg');
await exec('hdiutil', ['create', '-volname', 'LabCanvas', '-srcfolder', staging, '-ov', '-format', 'UDZO', dmg], { maxBuffer: 4 * 1024 * 1024 });
await writeFile('release/artifact.json', JSON.stringify({ version: '1.0.0', app_path: app, dmg_path: dmg, signing: 'ad-hoc' }, null, 2) + '\n');
console.log(JSON.stringify({ app, dmg, signing: 'ad-hoc' }, null, 2));
