const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// 这些用例会读写系统配置，必须与开发机上的真实 core/data 隔离，
// 否则本机已开启的 NapCat 开关会让断言随环境漂移。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-napcat-login-'));
process.env.FARM_DATA_DIR = dataDir;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function json(payload) {
  return { ok: true, status: 200, async text() { return JSON.stringify(payload); } };
}

test('NapCat login stays disabled unless explicitly enabled', () => {
  process.env.NAPCAT_LOGIN_ENABLED = 'false';
  delete require.cache[require.resolve('../src/services/napcat-login')];
  const service = require('../src/services/napcat-login');
  assert.equal(service.isConfigured(), false);
});

test('the NapCat login toggle survives a system config round-trip', () => {
  const store = require('../src/models/store');
  store.setSystemConfig({
    serverUrl: 'wss://gate-obt.nqf.qq.com/prod/ws',
    clientVersion: '1.13.0.5_20260723',
    platform: 'qq',
    os: 'iOS',
    napcatLoginEnabled: true,
  });
  assert.equal(store.getSystemConfig().napcatLoginEnabled, true);

  // 其他调用方以展开写法更新无关字段时，不能顺带把开关关掉。
  store.setSystemConfig({ ...store.getSystemConfig(), clientVersion: '1.13.1.6_20260729' });
  assert.equal(store.getSystemConfig().napcatLoginEnabled, true);

  // 只接受显式布尔 true，脏值一律按关闭处理。
  store.setSystemConfig({ ...store.getSystemConfig(), napcatLoginEnabled: 'yes' });
  assert.equal(store.getSystemConfig().napcatLoginEnabled, false);
  store.setSystemConfig({ ...store.getSystemConfig(), napcatLoginEnabled: false });
});

test('NapCat deployment is reported independently from the login toggle', () => {
  const store = require('../src/models/store');
  process.env.NAPCAT_LOGIN_ENABLED = 'false';
  process.env.NAPCAT_TOKEN = 'napcat-test-token';
  process.env.NAPCAT_WEBUI_URL = 'http://napcat-deploy.test/api';
  process.env.NAPCAT_OPENAUTH_URL = 'http://napcat-deploy.test/plugin';
  delete require.cache[require.resolve('../src/services/napcat-login')];
  const service = require('../src/services/napcat-login');

  // 容器已部署但开关关闭：入口不应开放。
  assert.equal(service.isDeployed(), true);
  assert.equal(service.isConfigured(), false);

  store.setSystemConfig({ ...store.getSystemConfig(), napcatLoginEnabled: true });
  delete require.cache[require.resolve('../src/services/napcat-login')];
  const enabledService = require('../src/services/napcat-login');
  assert.equal(enabledService.isConfigured(), true);

  // 缺少 Token 时即使开关为真也不视为可用。
  process.env.NAPCAT_TOKEN = '';
  process.env.NAPCAT_TOKEN_FILE = path.join(dataDir, 'missing-token');
  delete require.cache[require.resolve('../src/services/napcat-login')];
  assert.equal(require('../src/services/napcat-login').isDeployed(), false);
  delete process.env.NAPCAT_TOKEN_FILE;
});

test('NapCat prefers the shared token file over the environment value', async (t) => {
  // Windows 侧部署时 Token 由容器写入共享文件，行尾可能带 CRLF，需按最新内容取用。
  const tokenFile = path.join(os.tmpdir(), `napcat-token-${crypto.randomBytes(6).toString('hex')}.token`);
  fs.writeFileSync(tokenFile, 'file-token\r\n');
  t.after(() => fs.rmSync(tokenFile, { force: true }));
  Object.assign(process.env, {
    NAPCAT_LOGIN_ENABLED: 'true',
    NAPCAT_TOKEN: 'env-token',
    NAPCAT_TOKEN_FILE: tokenFile,
    NAPCAT_WEBUI_URL: 'http://napcat-file.test/api',
    NAPCAT_OPENAUTH_URL: 'http://napcat-file.test/plugin',
  });
  const expectedHash = crypto.createHash('sha256').update('file-token.napcat').digest('hex');
  const originalFetch = globalThis.fetch;
  const loginHashes = [];
  globalThis.fetch = async (url, options) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname.endsWith('/auth/login')) {
      loginHashes.push(JSON.parse(options.body).hash);
      return json({ code: 0, data: { Credential: 'credential' } });
    }
    if (pathname.endsWith('/QQLogin/CheckLoginStatus')) return json({ code: 0, data: { isLogin: false, isOffline: false } });
    if (pathname.endsWith('/QQLogin/GetQQLoginQrcode')) return json({ code: 0, data: { qrcode: 'https://example.test/qr' } });
    return json({ code: 0 });
  };
  t.after(() => { globalThis.fetch = originalFetch; delete process.env.NAPCAT_TOKEN_FILE; });

  delete require.cache[require.resolve('../src/services/napcat-login')];
  const service = require('../src/services/napcat-login');
  const task = await service.create('alice');
  assert.deepEqual(loginHashes, [expectedHash]);
  await service.cancel(task.taskId, 'alice');
});

test('NapCat QR flow obtains code, logs out, and enforces task ownership', async (t) => {
  Object.assign(process.env, {
    NAPCAT_LOGIN_ENABLED: 'true',
    NAPCAT_TOKEN: 'napcat-test-token',
    NAPCAT_WEBUI_URL: 'http://napcat.test/api',
    NAPCAT_OPENAUTH_URL: 'http://napcat.test/plugin',
  });
  const originalFetch = globalThis.fetch;
  const calls = [];
  let pluginStatusChecks = 0;
  let loginStatusChecks = 0;
  let loggedOut = false;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/auth/login')) return json({ code: 0, data: { Credential: 'credential' } });
    if (String(url).endsWith('/status')) return json({ ok: true, ready: ++pluginStatusChecks > 1 });
    if (String(url).endsWith('/QQLogin/GetQQLoginQrcode')) return json({ code: 0, data: { qrcode: 'https://example.test/qr' } });
    if (String(url).endsWith('/QQLogin/GetQQLoginInfo')) return json({ code: 0, data: { uin: '12345', nickname: '测试昵称' } });
    if (String(url).endsWith('/QQLogin/CheckLoginStatus')) {
      loginStatusChecks += 1;
      return json({ code: 0, status: 'success', data: { isLogin: !loggedOut && loginStatusChecks > 2 } });
    }
    if (String(url).endsWith('/miniapp')) return json({ ok: true, operation: 'loginWithAppId', code: 'farm-code', uin: '12345', nickname: '插件昵称' });
    if (String(url).endsWith('/logout')) {
      loggedOut = true;
      return json({ ok: true, loggedOut: true });
    }
    return json({ code: 0 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  delete require.cache[require.resolve('../src/services/napcat-login')];
  const service = require('../src/services/napcat-login');
  const task = await service.create('alice');
  assert.match(task.qrImage, /^data:image\/png;base64,/);
  assert.equal(calls.some(call => call.url.endsWith('/QQLogin/RefreshQRcode')), false);
  await assert.rejects(() => service.status(task.taskId, 'bob'), /不存在或已过期/);
  assert.equal((await service.status(task.taskId, 'alice')).status, 'waiting_scan');
  assert.equal((await service.status(task.taskId, 'alice')).status, 'confirmed');
  assert.deepEqual(await service.code(task.taskId, 'alice'), { code: 'farm-code', uin: '12345', nickname: '插件昵称' });
  assert.equal(pluginStatusChecks, 2);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(calls.some(call => call.url.endsWith('/logout')));
  assert.equal(calls.some(call => call.url.endsWith('/QQLogin/RestartNapCat')), false);

  const refreshed = await service.create('alice', { refresh: true });
  assert.ok(calls.some(call => call.url.endsWith('/QQLogin/RefreshQRcode')));
  await service.cancel(refreshed.taskId, 'alice');
});

test('NapCat clears a persisted offline session before requesting a new QR code', async (t) => {
  Object.assign(process.env, {
    NAPCAT_LOGIN_ENABLED: 'true',
    NAPCAT_TOKEN: 'napcat-test-token',
    NAPCAT_WEBUI_URL: 'http://napcat-stale.test/api',
    NAPCAT_OPENAUTH_URL: 'http://napcat-stale.test/plugin',
  });
  const originalFetch = globalThis.fetch;
  const calls = [];
  let phase = 'logged_in';
  globalThis.fetch = async (url, options) => {
    const pathname = new URL(String(url)).pathname;
    calls.push(pathname);
    if (pathname.endsWith('/auth/login')) return json({ code: 0, data: { Credential: 'credential' } });
    if (pathname.endsWith('/QQLogin/CheckLoginStatus')) {
      if (phase === 'logged_in') return json({ code: 0, data: { isLogin: true, isOffline: false } });
      if (phase === 'offline') return json({ code: 0, data: { isLogin: false, isOffline: true } });
      return json({ code: 0, data: { isLogin: false, isOffline: false } });
    }
    if (pathname.endsWith('/QQLogin/SetQuickLoginQQ')) return json({ code: 0 });
    if (pathname.endsWith('/logout')) {
      phase = 'offline';
      return json({ ok: true, loggedOut: true });
    }
    if (pathname.endsWith('/QQLogin/RestartNapCat')) {
      phase = 'logged_out';
      return json({ code: 0 });
    }
    if (pathname.endsWith('/QQLogin/GetQQLoginQrcode')) return json({ code: 0, data: { qrcode: 'https://example.test/new-qr' } });
    return json({ code: 0 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  delete require.cache[require.resolve('../src/services/napcat-login')];
  const service = require('../src/services/napcat-login');
  const task = await service.create('alice');
  assert.match(task.qrImage, /^data:image\/png;base64,/);
  assert.ok(calls.some(pathname => pathname.endsWith('/QQLogin/SetQuickLoginQQ')));
  assert.ok(calls.some(pathname => pathname.endsWith('/logout')));
  assert.ok(calls.some(pathname => pathname.endsWith('/QQLogin/RestartNapCat')));
  assert.ok(calls.indexOf('/api/QQLogin/RestartNapCat') < calls.indexOf('/api/QQLogin/GetQQLoginQrcode'));
  await service.cancel(task.taskId, 'alice');
});
