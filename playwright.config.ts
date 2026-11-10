import { defineConfig } from '@playwright/test';
// Tests only contact loopback; avoid the workstation's outbound proxy.
for (const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']) delete process.env[key];
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';
export default defineConfig({
  testDir:'./tests/e2e',fullyParallel:false,workers:1,timeout:45000,
  expect:{timeout:10000},reporter:[['list'],['html',{open:'never'}]],
  use:{baseURL:'http://127.0.0.1:4327',viewport:{width:1500,height:980},trace:'retain-on-failure',screenshot:'only-on-failure'},
  webServer:{command:'node scripts/e2e-server.mjs',url:'http://127.0.0.1:4327/api/health',reuseExistingServer:false,timeout:30000}
});
