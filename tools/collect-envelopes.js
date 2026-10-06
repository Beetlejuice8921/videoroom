// Records loudness envelopes of labelled videos with the extension's own
// capture code (src/content/audio-sync.js) in a headless browser, for tuning
// the audio check offline. Output: tools/data/envelopes-<name>.json
// Usage: node tools/collect-envelopes.js
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep, ROOT } = require('./lib/browser');

// label: 1 = same performance as the seed, 0 = another one, 2 = unknown (from titles).
const SETS = {
  coldplay: {
    seed: 'EGx-YKD3TR0', // Viva La Vida, Wembley 16/08/2022
    videos: {
      nq78Nftft74: 1, '6CfgAaBUjCA': 1, AQes5o4rwqA: 1,
      m0oDGSzJbgc: 0, QShB5GP0OKc: 0, KCa0fbVfMus: 0, Xk8pMlMWAu4: 0, '6bNx1OrHFQI': 0, gSBt2Dp8JuI: 0,
      eZB3nubHqFg: 0, '-ZvsGmYKhcU': 0, bywnNf6CHSI: 2, EPJw10eVeYU: 2, GYyYIOAw30g: 2,
    },
  },
  newjeans: {
    seed: 'mCjarmgflEc', // Super Shy, Lollapalooza 2023
    videos: {
      Oh7hRBpjepU: 1, wVkpSGKp7r8: 1, P2s3SATge_Y: 1, DtYl98I3s6E: 1, V3_8HgCHNHo: 1, ZxyboyDJHlc: 1,
      CUeaq2QmMwE: 1, M7qiFToPfCM: 1, '4wUOExt2sto': 1, NdB_ZhPK1ko: 1, wB90h_dItiw: 1,
      NcVmXeNEGUQ: 0, wU2siJ2c5TA: 0,
    },
  },
};

(async () => {
  const outDir = path.join(ROOT, 'tools', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const code = fs.readFileSync(path.join(ROOT, 'src/content/audio-sync.js'), 'utf8');
  const browser = await launch();
  try {
    for (const [name, set] of Object.entries(SETS)) {
      const file = path.join(outDir, `envelopes-${name}.json`);
      const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { seed: set.seed, env: {} };
      data.labels = set.videos;
      const page = await browser.open(`https://www.youtube.com/watch?v=${set.seed}`);
      await page.waitFor(`!!document.getElementById('movie_player')?.getVideoData`, 30000);
      await page.activate();
      // The extension's module in the page's main world, with an in-memory cache shim.
      await page.evaluate(`(() => {
        window.chrome = window.chrome || {};
        const mem = {};
        chrome.storage = { local: { get: async (k) => (k in mem ? { [k]: mem[k] } : {}), set: async (o) => Object.assign(mem, o) } };
        ${code}
        const mp = document.getElementById('movie_player');
        window.__cap = new VRAudioSync.Capture({
          video: mp.querySelector('video'), playerEl: mp,
          load: (id, s) => mp.loadVideoById({ videoId: id, startSeconds: s }),
          nativeVideoId: () => mp.getVideoData()?.video_id,
        });
        return true;
      })()`);
      for (const id of [set.seed, ...Object.keys(set.videos)]) {
        if (data.env[id]) continue;
        const rate = id === set.seed ? 8 : 16;
        const t0 = Date.now();
        try {
          const env = await page.evaluate(`(async () => {
            const { samples, dur } = await __cap.record(${JSON.stringify(id)}, 0, Infinity, ${rate}, '');
            return Array.from(VRAudioSync.toGrid(samples, dur), (x) => Math.round(x * 1e5) / 1e5);
          })()`);
          data.env[id] = env;
          console.log(`${name} ${id}: ${env.length} pts, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
        } catch (err) {
          console.log(`${name} ${id}: FAILED ${err.message.split('\n')[0]}`);
        }
        fs.writeFileSync(file, JSON.stringify(data));
        await sleep(500);
      }
      page.close();
    }
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
