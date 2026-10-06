// Headless Edge/Chrome with the unpacked extension, driven over the DevTools
// protocol. Uses a throwaway profile, so the user's browsers are untouched.
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) {
      for (const fn of listeners.get(m.method) || []) fn(m.params);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
    return r.result.value;
  };
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) || []), fn]);
  const waitFor = async (expr, timeout = 30000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (await evaluate(expr).catch(() => false)) return true;
      await sleep(500);
    }
    return false;
  };
  return { send, evaluate, on, waitFor, close: () => ws.close() };
}

async function launch({ port = 9333 } = {}) {
  const exe = BROWSERS.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('Edge/Chrome not found');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-browser-'));
  const proc = spawn(exe, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--load-extension=${ROOT}`,
    `--disable-extensions-except=${ROOT}`,
    '--window-size=1280,800',
    '--lang=ru',
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]);
  const base = `http://127.0.0.1:${port}`;
  const targets = () => fetch(`${base}/json/list`).then((r) => r.json());

  let worker = null;
  for (let i = 0; i < 40 && !worker; i++) {
    await sleep(500);
    worker = (await targets().catch(() => [])).find((t) => t.type === 'service_worker' && t.url.includes('src/background.js'));
  }
  if (!worker) {
    proc.kill();
    throw new Error('extension service worker not found (is --load-extension supported?)');
  }

  return {
    // Runs code in the extension's service worker (chrome.* APIs available).
    async extension(expression) {
      const sw = await connect(worker.webSocketDebuggerUrl);
      try {
        return await sw.evaluate(expression);
      } finally {
        sw.close();
      }
    },
    async open(url) {
      const t = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((r) => r.json());
      const page = await connect(t.webSocketDebuggerUrl);
      await page.send('Page.enable');
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      // Accept the extension's confirm() prompts (audio sync / audio check).
      page.on('Page.javascriptDialogOpening', () => page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}));
      // A real user has interacted with the page before pressing our buttons;
      // without that, Chrome blocks unmuted playback and audio capture stalls.
      page.activate = async () => {
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
      };
      return page;
    },
    async close() {
      proc.kill();
      await sleep(1000);
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

module.exports = { launch, sleep, ROOT };
