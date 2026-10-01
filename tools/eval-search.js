// Measures "Найти ракурсы" quality against known multi-angle events.
// Usage: node tools/eval-search.js [--verbose]
//
// For every seed video of an event: how many of the other known angles land
// in the top 10 (recall), and how many known wrong videos do (noise).
'use strict';

const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
  cookie: 'CONSENT=YES+1; SOCS=CAI',
};
globalThis.VR_SEARCH_FETCH = (path) => fetch('https://www.youtube.com' + path, { headers: HEADERS }).then((r) => r.text());
require(process.env.SEARCH_IMPL || '../src/content/angle-search.js');
const { findAngles } = globalThis.VRAngleSearch;

const EVENTS = [
  {
    name: 'KOD 2016 semifinal Hip Hop France vs China',
    angles: ['W7HeG_V_eBo', 'SSutx6RUza8', 'zYjWI0eL41o', '_AhXAGFlLu8'],
    // Re-uploads of the same footage also count as correct.
    alsoCorrect: (c) => /france|criminalz|les twins/i.test(c.title) && /china/i.test(c.title) && /semi/i.test(c.title + ' ' + (c.description || '')) && !/popp|lock/i.test(c.title),
    // Clearly another battle of the same tournament.
    wrong: (c) => /canada|korea|usa|japan|quarter|popp|lock|top\s?8|\bfinals?\b(?!.*semi)/i.test(c.title) && !/semi/i.test(c.title),
  },
];

const verbose = process.argv.includes('--verbose');

(async () => {
  let totalRecall = 0;
  let totalPossible = 0;
  let totalWrong = 0;
  for (const ev of EVENTS) {
    console.log(`\n=== ${ev.name}`);
    for (const seed of ev.angles) {
      const others = ev.angles.filter((a) => a !== seed);
      const t0 = Date.now();
      const { candidates, total } = await findAngles(seed);
      const top = candidates.slice(0, 10);
      const hit = others.filter((a) => top.some((c) => c.videoId === a));
      const reupload = top.filter((c) => !ev.angles.includes(c.videoId) && ev.alsoCorrect(c));
      const wrong = top.filter((c) => !ev.angles.includes(c.videoId) && !ev.alsoCorrect(c) && ev.wrong(c));
      totalRecall += hit.length;
      totalPossible += others.length;
      totalWrong += wrong.length;
      console.log(
        `seed ${seed}: angles ${hit.length}/${others.length}, re-uploads ${reupload.length}, wrong ${wrong.length} ` +
          `(pool ${total}, ${((Date.now() - t0) / 1000).toFixed(1)} s)`
      );
      if (verbose) {
        candidates.forEach((c, i) => {
          const tag = ev.angles.includes(c.videoId) ? '★' : ev.alsoCorrect(c) ? '☆' : ev.wrong(c) ? '✗' : ' ';
          console.log(`  ${String(i + 1).padStart(2)} ${tag} ${c.score.toFixed(2)} ${c.title.slice(0, 80)} [${c.channel}] ${c.why.join(', ')}`);
        });
      }
    }
  }
  console.log(`\nTOTAL: recall ${totalRecall}/${totalPossible}, wrong in top-10: ${totalWrong}`);
})();
