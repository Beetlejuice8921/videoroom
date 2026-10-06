// Takes Chrome Web Store screenshots (1280×800) with the unpacked extension:
// seeds the example room through the extension's service worker and shoots
// the YouTube strip, the "find angles" panel and the cinema.
// Usage: node tools/store-screenshots.js
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep, ROOT } = require('./lib/browser');

const OUT = path.join(ROOT, 'store', 'screenshots');

async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
  console.log('saved', name);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  try {
    // Seed the example room, with the venue map arranged, into extension storage.
    const room = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/kod2016-semifinal-france-china.json'), 'utf8'));
    room.id = 'rkodexample';
    room.updatedAt = Date.now();
    const pos = [{ x: 0.3, y: 0.62 }, { x: 0.86, y: 0.42 }, { x: 0.55, y: 0.85 }, { x: 0.14, y: 0.4 }];
    room.cameras.forEach((c, i) => (c.pos = pos[i]));
    await browser.extension(`chrome.storage.local.set(${JSON.stringify({ rooms: { [room.id]: room }, settings: { useShared: false } })}).then(() => true)`);

    // 1. YouTube page with the camera strip.
    const yt = await browser.open('https://www.youtube.com/watch?v=W7HeG_V_eBo&t=420');
    await yt.waitFor(`!!document.querySelector('.vr-strip .vr-cam')`, 45000);
    await yt.evaluate(`(() => { const v = document.querySelector('video'); if (v) { v.muted = true; v.currentTime = 420; v.play(); } return true; })()`);
    await sleep(6000);
    // Theater mode: the player spans the width and recommendations move below it.
    await yt.evaluate(`document.querySelector('.ytp-size-button')?.click(), true`);
    await sleep(2500);
    // The recommendations column is random content, not ours to show.
    await yt.evaluate(`(() => { const st = document.createElement('style'); st.textContent = '#secondary, ytd-watch-next-secondary-results-renderer { display: none !important; }'; document.head.append(st); return true; })()`);
    await sleep(1000);
    // Scroll so the strip sits at the bottom of the frame, player above it.
    await yt.evaluate(`(() => { const r = document.querySelector('.vr-strip').getBoundingClientRect(); window.scrollBy(0, r.bottom - 792); return true; })()`);
    await sleep(1500);
    await shot(yt, '1-youtube-strip.png');

    // 2. Find angles panel.
    await yt.evaluate(`document.querySelector('[data-search]')?.click(), true`);
    await yt.waitFor(`document.querySelectorAll('.vr-cand').length > 0`, 60000);
    await yt.evaluate(`document.querySelector('.vr-search')?.scrollIntoView({ block: 'center' }), true`);
    await sleep(2500);
    await shot(yt, '3-find-angles.png');
    yt.close();

    // 3. Cinema.
    global.chrome = undefined;
    require(path.join(ROOT, 'src/shared/rooms.js'));
    const hash = globalThis.VR.encodeRoomHash({ room, cam: room.cameras[1].videoId, t: 420 });
    const cin = await browser.open('https://beetlejuice8921.github.io/videoroom-cinema/room/room.html?shot=1' + hash);
    await cin.waitFor(`!!document.getElementById('start')`, 20000);
    await sleep(5000);
    await cin.evaluate(`document.getElementById('start').click(), true`);
    await cin.waitFor(`[...document.querySelectorAll('.cam.ready')].length >= 3`, 40000);
    // Let the warm pool settle, then switch once so the crossfade has finished.
    await sleep(6000);
    await cin.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1', bubbles: true })), true`);
    await sleep(5000);
    await shot(cin, '2-cinema.png');
    cin.close();
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
