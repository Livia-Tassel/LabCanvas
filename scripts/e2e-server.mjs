import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../server/index.mjs';
const home=await mkdtemp(path.join(os.tmpdir(),'labcanvas-e2e-'));
const { stop } = await startServer({ home, port: 4327 });
const close = async () => {
  await stop();
  await rm(home, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGTERM',close);process.on('SIGINT',close);
