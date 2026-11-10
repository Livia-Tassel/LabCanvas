import { pathToFileURL } from 'node:url';
import { createApp } from './app.mjs';
import { seedDemo } from './demo.mjs';
export async function startServer({ home, port = Number(process.env.PORT || 4317), demo = process.env.LABCANVAS_NO_DEMO !== '1', staticDir } = {}) {
  const { app, store } = createApp({ home, staticDir });
  let server;
  try {
    if (demo && store.projects().length === 0) await seedDemo(store);
    server = await new Promise((resolve, reject) => { const s = app.listen(port, '127.0.0.1', error => error ? reject(error) : resolve(s)); s.on('error', reject); });
  } catch (error) { store.close(); throw error; }
  const actualPort = server.address().port;
  console.log(`LabCanvas v1.0.0 · http://127.0.0.1:${actualPort}`);
  return { server, store, url: `http://127.0.0.1:${actualPort}` };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().then(({ server, store }) => {
    const stop = () => server.close(() => { store.close(); process.exit(0); });
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
