import { pathToFileURL } from 'node:url';
import { createApp, VERSION } from './app.mjs';

export { VERSION };

export async function startServer({ home, port = Number(process.env.PORT || 4317), staticDir } = {}) {
  const { app, store, close } = createApp({ home, staticDir });
  let server;
  try {
    server = await new Promise((resolve, reject) => {
      const listening = app.listen(port, '127.0.0.1', error => (error ? reject(error) : resolve(listening)));
      listening.on('error', reject);
    });
  } catch (error) {
    close();
    store.close();
    throw error;
  }
  const url = `http://127.0.0.1:${server.address().port}`;
  const stop = () => new Promise(resolve => {
    close();
    server.closeAllConnections();
    server.close(() => {
      store.close();
      resolve();
    });
  });
  return { server, store, url, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().then(({ url, stop }) => {
    console.log(`LabCanvas ${VERSION} · ${url}`);
    const exit = () => stop().then(() => process.exit(0));
    process.on('SIGTERM', exit);
    process.on('SIGINT', exit);
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
