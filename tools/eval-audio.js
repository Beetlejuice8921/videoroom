// End-to-end check of "Найти ракурсы" + "🎧 Проверить звуком" in a real
// browser with the extension: opens a seed video, runs the search, runs the
// audio check and reports which candidates share audio with the seed.
// Audio-verified candidates are the ground truth for the title ranking.
// Usage: node tools/eval-audio.js [videoId ...]   (default: built-in events)
'use strict';

const { launch, sleep } = require('./lib/browser');

const EVENTS = [
  { name: 'NewJeans «Super Shy», Lollapalooza 2023', seed: 'Oh7hRBpjepU' },
  { name: 'Coldplay «Viva La Vida», Wembley 16.08.2022', seed: 'EGx-YKD3TR0' },
  { name: 'Red Bull BC One 2023, финал Hong 10 vs Phil Wizard', seed: 'w1hqlImawmc' },
  { name: 'KOD 2016, полуфинал France vs China (контроль)', seed: '_AhXAGFlLu8' },
];

async function runEvent(browser, ev) {
  const page = await browser.open(`https://www.youtube.com/watch?v=${ev.seed}`);
  try {
    if (!(await page.waitFor(`!!document.querySelector('.vr-finder')`, 45000))) throw new Error('finder bar did not appear');
    await page.activate();
    await page.evaluate(`document.querySelector('.vr-finder .vr-btn-accent').click(), true`);
    await page.waitFor(`document.querySelectorAll('.vr-cand').length > 0 || /не нашлось|не удался/.test(document.querySelector('.vr-search > .vr-hint')?.textContent || '')`, 90000);
    const found = await page.evaluate(`document.querySelector('.vr-search > .vr-hint').textContent`);

    const t0 = Date.now();
    await page.evaluate(`[...document.querySelectorAll('.vr-search .vr-btn')].find((b) => b.textContent.includes('Проверить звуком')).click(), true`);
    let last = '';
    while (Date.now() - t0 < 20 * 60000) {
      await sleep(5000);
      const st = await page.evaluate(`document.querySelector('.vr-search > .vr-hint').textContent`).catch(() => '');
      if (st !== last) process.stdout.write(`    ${st}\n`), (last = st);
      if (/закончена|остановлена|не удалась/.test(st)) break;
    }
    const rows = await page.evaluate(`[...document.querySelectorAll('.vr-cand')].map((el, i) => ({
      rank: i + 1,
      doubtful: !!el.closest('.vr-cands-sep + .vr-cands'),
      title: el.querySelector('.vr-cand-title').textContent,
      meta: el.querySelector('.vr-cand-info .vr-hint').textContent,
      badge: el.querySelector('.vr-badge').textContent,
    }))`);
    return { found, rows, seconds: Math.round((Date.now() - t0) / 1000) };
  } finally {
    page.close();
  }
}

(async () => {
  const seeds = process.argv.slice(2);
  const events = seeds.length ? seeds.map((seed) => ({ name: seed, seed })) : EVENTS;
  const browser = await launch();
  const summary = [];
  try {
    await browser.extension(`chrome.storage.local.set({ settings: { useShared: false } }).then(() => true)`);
    for (const ev of events) {
      console.log(`\n=== ${ev.name} (${ev.seed})`);
      try {
        const { found, rows, seconds } = await runEvent(browser, ev);
        console.log(`  ${found}`);
        for (const r of rows) {
          const mark = r.badge.startsWith('✓') ? '✓' : r.badge.startsWith('?') ? '?' : r.badge.startsWith('✗') ? '✗' : '·';
          console.log(`  ${String(r.rank).padStart(2)} ${mark} ${r.doubtful ? '[сомн] ' : ''}${r.title.slice(0, 70)} — ${r.meta.slice(0, 60)}${r.badge ? ' | ' + r.badge : ''}`);
        }
        const checked = rows.filter((r) => r.badge && !r.badge.includes('слушаю'));
        const ok = checked.filter((r) => r.badge.startsWith('✓'));
        const top5 = rows.filter((r) => !r.doubtful).slice(0, 5);
        summary.push(
          `${ev.name}: проверено ${checked.length}, общий звук ${ok.length}; в топ-5 подтверждено ${top5.filter((r) => r.badge.startsWith('✓')).length}/5; ` +
            `подтверждённых среди сомнительных ${ok.filter((r) => r.doubtful).length}; ${seconds} с`
        );
      } catch (err) {
        summary.push(`${ev.name}: ошибка — ${err.message}`);
      }
    }
  } finally {
    await browser.close();
  }
  console.log('\n' + summary.join('\n'));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
