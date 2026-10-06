// "Найти другие ракурсы": finds other uploads of the same event on YouTube.
//
// Candidates come from three sources:
//   1. YouTube search with queries built from the title;
//   2. the seed's related videos (other angles often sit right there);
//   3. a snowball round: search + related videos of the best early matches,
//      which catches angles titled differently from the seed.
// Ranking is title similarity plus event rules: the "X vs Y" pair, the stage
// (semi/quarter/final…), the discipline (hip hop/popping…), the year and the
// exact upload date. Runs in the content script on youtube.com (same-origin
// requests); tools/eval-search.js runs the same code from Node.
(() => {
  'use strict';

  const DAY = 86400000;
  const MAX_RESULTS = 15;
  const DETAIL_TOP = 15; // fetch exact date/description for this many
  const SNOWBALL_SEEDS = 3;

  // Pluggable for Node: (path) => Promise<string html>.
  const fetchText =
    globalThis.VR_SEARCH_FETCH ||
    ((path) => fetch(path, { credentials: 'include' }).then((r) => r.text()));

  // ---------- text features ----------

  // Words that say nothing about which event it is.
  const STOP = new Set(
    (
      'the a an and or of in on at to for with by from vs v x feat ft official video videos clip hd hq fhd uhd 4k 8k ' +
      '1080p 720p 60fps full live stream livestream angle cam camera view pov fancam footage part new best top ' +
      'и в во на с со по из за для от до к ко у о об без под над при про или но не это как что вид ракурс камера ' +
      'видео полное полная запись прямой эфир трансляция часть'
    ).split(' ')
  );

  function words(text) {
    return [...String(text || '').toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map((m) => m[0]);
  }

  function tokens(text) {
    return words(text).filter((t) => t.length >= 2 && !STOP.has(t));
  }

  // Words plus adjacent pairs glued together, so "semi final" matches "semifinal".
  function matchSet(list) {
    const s = new Set(list);
    for (let i = 0; i + 1 < list.length; i++) s.add(list[i] + list[i + 1]);
    return s;
  }

  // Overlap of distinctive words, 0..1.
  function titleSimilarity(a, b) {
    const ta = tokens(a);
    const tb = tokens(b);
    const A = new Set(ta);
    const B = new Set(tb);
    if (!A.size || !B.size) return 0;
    const ma = matchSet(ta);
    const mb = matchSet(tb);
    let ca = 0;
    for (const t of A) if (mb.has(t)) ca++;
    let cb = 0;
    for (const t of B) if (ma.has(t)) cb++;
    return Math.max(ca / A.size, cb / B.size, (ca / Math.min(A.size, B.size)) * 0.85);
  }

  // "Criminalz (FRANCE) vs CHINA" → sides {criminalz, france} and {china}.
  // Each side keeps up to three telling words (no "b-boy", "team", years…);
  // two pairs are the same battle if both sides share a word, in either order.
  const VS = new Set(['vs', 'v', 'versus', 'против']);
  const SIDE_SKIP = new Set(
    'b boy bboy bgirl girl mc dj team crew the and of final finals semi semifinal quarter battle round top live'.split(' ')
  );
  function vsPair(text) {
    const segments = String(text || '')
      // (Round brackets usually wrap the sides, "(FRANCE) vs (CHINA)"; square
      // ones hold notes like "[4K]" or "[stance angle]" and end a segment.)
      .replace(/[(){}]/g, ' ')
      .split(/\s[-–—]\s|[|/\\:•[\]【】]+/);
    for (const seg of segments) {
      const w = words(seg);
      const i = w.findIndex((x) => VS.has(x));
      if (i <= 0 || i >= w.length - 1) continue;
      const side = (list) => list.filter((x) => !SIDE_SKIP.has(x) && !STOP.has(x) && !/^(19|20)\d\d$/.test(x)).slice(0, 3);
      const left = side(w.slice(0, i).reverse());
      const right = side(w.slice(i + 1));
      if (!left.length || !right.length) continue;
      if ([...left, ...right].every((x) => /^d+$/.test(x))) continue; // a score like "2 v 1"
      const key = [[...left].sort().join(' '), [...right].sort().join(' ')].sort().join('|');
      return { left: new Set(left), right: new Set(right), key };
    }
    return null;
  }

  function samePair(p, q) {
    const meet = (a, b) => [...a].some((x) => b.has(x));
    return (meet(p.left, q.left) && meet(p.right, q.right)) || (meet(p.left, q.right) && meet(p.right, q.left));
  }

  const STAGES = [
    ['semi', /semi[\s-]?finals?|semifinals?|\b1\/2\b|полуфинал/i],
    ['quarter', /quarter[\s-]?finals?|\b1\/4\b|четвертьфинал/i],
    ['top8', /top\s?8\b|\b1\/8\b/i],
    ['top16', /top\s?16\b|\b1\/16\b/i],
    ['prelims', /prelim|qualif|pre-?selection|отбор|квалиф/i],
    ['final', /\bfinals?\b|\bфинал/i],
  ];
  function stage(text) {
    for (const [name, re] of STAGES) if (re.test(text)) return name; // order matters: semi before final
    return null;
  }

  const DISCIPLINES = [
    ['hiphop', /hip[\s-]?hop|хип[\s-]?хоп/i],
    ['popping', /\bpopp?in[g']?\b|поппинг/i],
    ['locking', /\blocking\b|локинг/i],
    ['breaking', /breaking|breakdance|b-?boy|b-?girl|брейк/i],
    ['house', /\bhouse\b|хаус/i],
    ['krump', /krump/i],
    ['waacking', /wh?aacking|whacking/i],
    ['vogue', /\bvogu(e|ing)\b/i],
    ['allstyle', /all[\s-]?styles?/i],
  ];
  function disciplines(text) {
    return new Set(DISCIPLINES.filter(([, re]) => re.test(text)).map(([name]) => name));
  }

  function years(text) {
    return new Set(words(text).filter((w) => /^(19|20)\d\d$/.test(w)));
  }

  const isPromo = (text) => /highlight|recap|trailer|teaser|reaction|реакция|обзор|анонс/i.test(text);

  // ---------- YouTube page parsing ----------

  function parseDuration(text) {
    const parts = String(text || '').trim().split(':').map(Number);
    if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return null;
    return parts.reduce((s, n) => s * 60 + n, 0);
  }

  // "8 years ago" (requests use hl=en) → approximate timestamp.
  function parseAgo(text, now = Date.now()) {
    const m = String(text || '').match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
    if (!m) return null;
    const unit = { second: 1000, minute: 60000, hour: 3600000, day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY }[
      m[2].toLowerCase()
    ];
    return now - Number(m[1]) * unit;
  }

  function extractJson(html, varName) {
    const start = html.indexOf(`var ${varName} = `);
    if (start < 0) return null;
    const from = html.indexOf('{', start);
    // Walk braces (string-aware) to find the end of the object literal.
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = from; i < html.length; i++) {
      const ch = html[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          return JSON.parse(html.slice(from, i + 1));
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  const text = (t) => t?.simpleText ?? t?.runs?.map((r) => r.text).join('') ?? t?.content ?? '';

  // Search results (videoRenderer) and related videos (lockupViewModel).
  function collectVideos(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
      for (const x of node) collectVideos(x, out);
      return out;
    }
    const vr = node.videoRenderer;
    if (vr?.videoId) {
      out.push({
        videoId: vr.videoId,
        title: text(vr.title),
        channel: text(vr.ownerText) || text(vr.longBylineText),
        duration: parseDuration(text(vr.lengthText)),
        published: parseAgo(text(vr.publishedTimeText)),
        isLive: !vr.lengthText,
      });
    }
    const lv = node.lockupViewModel;
    if (lv?.contentId && /VIDEO/.test(lv.contentType || 'VIDEO')) {
      const meta = lv.metadata?.lockupMetadataViewModel;
      const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows || [];
      const parts = rows.flatMap((r) => (r.metadataParts || []).map((p) => text(p.text)));
      const badge = JSON.stringify(lv.contentImage || {}).match(/"text":"(\d+:\d\d(?::\d\d)?)"/);
      out.push({
        videoId: lv.contentId,
        title: text(meta?.title),
        channel: parts[0] || '',
        duration: badge ? parseDuration(badge[1]) : null,
        published: parts.map((p) => parseAgo(p)).find(Boolean) || null,
        isLive: !badge,
      });
    }
    for (const k in node) if (k !== 'videoRenderer' && k !== 'lockupViewModel') collectVideos(node[k], out);
    return out;
  }

  const infoCache = new Map();
  function fetchVideoInfo(videoId) {
    if (!infoCache.has(videoId)) {
      infoCache.set(
        videoId,
        fetchText(`/watch?v=${videoId}&hl=en`).then((html) => {
          const pr = extractJson(html, 'ytInitialPlayerResponse');
          const vd = pr?.videoDetails;
          if (!vd) throw new Error('не удалось прочитать данные видео');
          const mf = pr?.microformat?.playerMicroformatRenderer;
          return {
            videoId,
            title: vd.title,
            channel: vd.author,
            duration: Number(vd.lengthSeconds) || null,
            published: mf?.publishDate ? Date.parse(mf.publishDate) : null,
            description: vd.shortDescription || '',
            related: collectVideos(extractJson(html, 'ytInitialData')).filter((v) => v.videoId !== videoId),
          };
        })
      );
    }
    return infoCache.get(videoId);
  }

  async function searchYouTube(query) {
    const html = await fetchText(`/results?search_query=${encodeURIComponent(query)}&hl=en`);
    return collectVideos(extractJson(html, 'ytInitialData'));
  }

  // Runs async jobs with limited parallelism.
  async function pool(items, limit, job) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
          const i = next++;
          try {
            out[i] = await job(items[i]);
          } catch {
            out[i] = null;
          }
        }
      })
    );
    return out;
  }

  // ---------- queries & scoring ----------

  function cleanTitle(title) {
    return String(title)
      .replace(/[[(【].*?[\])】]/g, ' ')
      .replace(/[|│•@#/\\]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Event name without the noise, plus its most distinctive words.
  function buildQueries(info) {
    const cleaned = cleanTitle(info.title);
    const queries = [cleaned];
    // Numbers (years, dates), ALL-CAPS acronyms (event names like KOD) and
    // longer words carry the event identity.
    const caps = new Set([...cleaned.matchAll(/\b[\p{Lu}\d]{2,}\b/gu)].map((m) => m[0].toLowerCase()));
    const key = [...new Set(tokens(cleaned).filter((t) => /\d/.test(t) || caps.has(t) || t.length >= 4))].slice(0, 8);
    if (key.length >= 2 && key.join(' ') !== cleaned.toLowerCase()) queries.push(key.join(' '));
    if (key.length >= 2) queries.push(key.slice(0, 5).join(' ') + ' angle');
    return queries;
  }

  // Event features of a video, from its title (description as a fallback).
  function eventOf(v) {
    const t = v.title || '';
    const d = (v.description || '').slice(0, 400);
    const ds = disciplines(t);
    return {
      pair: vsPair(t) || (d ? vsPair(d) : null),
      stage: stage(t) || (d ? stage(d) : null),
      disciplines: ds.size ? ds : disciplines(d),
      years: years(t),
    };
  }

  function score(seed, seedEv, c) {
    const ev = eventOf(c);
    const why = [];
    const sim = titleSimilarity(seed.title + ' ' + seed.description.slice(0, 200), c.title + ' ' + (c.description || '').slice(0, 120));
    let s = sim;

    // Contradictions in pair / stage / discipline almost always mean another battle.
    if (seedEv.pair && ev.pair) {
      if (samePair(seedEv.pair, ev.pair)) (s += 0.2), why.push('те же соперники');
      else (s -= 0.8), why.push('другие соперники');
    }
    if (seedEv.stage && ev.stage) {
      if (seedEv.stage === ev.stage) s += 0.1;
      else (s -= 0.7), why.push('другая стадия');
    }
    if (seedEv.disciplines.size && ev.disciplines.size && ![...ev.disciplines].some((x) => seedEv.disciplines.has(x))) {
      s -= 0.8;
      why.push('другая дисциплина');
    }
    if (seedEv.years.size && ev.years.size && ![...ev.years].some((y) => seedEv.years.has(y))) {
      s -= 0.4;
      why.push('другой год');
    }

    if (seed.published && c.published) {
      const days = Math.abs(seed.published - c.published) / DAY;
      s += c.exactDate ? 0.25 * Math.exp(-days / 30) : 0.1 * Math.exp(-days / 120);
      if (c.exactDate && days <= 3) why.push('загружено в те же дни');
    }
    if (seed.duration && c.duration) s += 0.05 * (Math.min(seed.duration, c.duration) / Math.max(seed.duration, c.duration));
    if (c.duration && c.duration < 60) (s -= 0.4), why.push('слишком короткое');
    if (c.isLive) s -= 0.2;
    if (isPromo(c.title) && !isPromo(seed.title)) (s -= 0.3), why.push('нарезка/обзор');
    if (c.fromRelated) (s += 0.1), why.push('в похожих у YouTube');
    else if (c.fromSnowball) s += 0.05;

    const doubtful = why.some((w) => w.startsWith('друг'));
    return { ...c, score: s, similarity: sim, why, doubtful };
  }

  // Doubtful candidates (contradicting pair/stage/discipline/year) always go last.
  const byRank = (a, b) => a.doubtful - b.doubtful || b.score - a.score;

  // Fills the seed's missing stage/discipline from confident matches: if the
  // seed says only "Dance Battle" but the clean same-pair matches agree on
  // "hip hop, semi", treat the seed as that.
  function inferSeedEvent(seedEv, ranked) {
    const sure = ranked.filter((c) => !c.doubtful && c.similarity >= 0.5).slice(0, 6);
    // Score-weighted vote; the winner must clearly beat the runner-up.
    const pick = (getValues) => {
      const votes = new Map();
      for (const c of sure) for (const v of getValues(eventOf(c))) if (v) votes.set(v, (votes.get(v) || 0) + Math.max(0.1, c.score));
      const [first, second] = [...votes].sort((a, b) => b[1] - a[1]);
      if (!first || first[1] < 1) return null;
      return !second || first[1] >= second[1] * 1.2 ? first[0] : null;
    };
    const out = { ...seedEv };
    if (!out.pair) {
      const key = pick((e) => [e.pair?.key]);
      out.pair = key ? sure.map(eventOf).find((e) => e.pair?.key === key).pair : null;
    }
    if (!out.stage) out.stage = pick((e) => [e.stage]);
    if (!out.disciplines.size) {
      const d = pick((e) => [...e.disciplines]);
      if (d) out.disciplines = new Set([d]);
    }
    return out;
  }

  // ---------- pipeline ----------

  // onProgress(text) is optional. Returns ranked candidates without `exclude`.
  async function findAngles(videoId, exclude = new Set(), onProgress) {
    const seed = await fetchVideoInfo(videoId);
    let seedEv = eventOf(seed);
    const skip = new Set([videoId, ...exclude]);
    const found = new Map();
    const add = (list, flags) => {
      for (const c of list) {
        if (!c?.videoId || skip.has(c.videoId)) continue;
        const prev = found.get(c.videoId);
        found.set(c.videoId, { ...c, ...prev, ...Object.fromEntries(Object.entries(flags).filter(([, v]) => v)) });
      }
    };

    onProgress?.('Ищу по названию…');
    add(seed.related, { fromRelated: true });
    for (const list of await pool(buildQueries(seed), 3, searchYouTube)) add(list || [], {});

    const rank = () => [...found.values()].map((c) => score(seed, seedEv, c)).sort(byRank);

    // Snowball from the best clean matches: their titles and related videos.
    onProgress?.('Ищу по найденным ракурсам…');
    const seeds = rank()
      .filter((c) => !c.doubtful && c.similarity >= 0.5)
      .slice(0, SNOWBALL_SEEDS);
    await pool(seeds, 3, async (c) => {
      const { related, ...info } = await fetchVideoInfo(c.videoId);
      add([{ ...info, exactDate: !!info.published }], {});
      add(related, { fromSnowball: true });
      add(await searchYouTube(cleanTitle(info.title)), { fromSnowball: true });
    });

    // Exact dates and descriptions for the top of the list.
    onProgress?.('Уточняю даты и описания…');
    const top = rank().slice(0, DETAIL_TOP);
    const details = await pool(top, 4, (c) => fetchVideoInfo(c.videoId));
    details.forEach((info, i) => {
      if (!info) return;
      const { related, ...rest } = info;
      found.set(top[i].videoId, { ...found.get(top[i].videoId), ...rest, exactDate: !!info.published });
    });

    seedEv = inferSeedEvent(seedEv, rank());
    const ranked = rank().filter((c) => c.score >= 0.35);
    return { info: seed, candidates: ranked.slice(0, MAX_RESULTS), total: found.size };
  }

  globalThis.VRAngleSearch = {
    findAngles,
    buildQueries,
    cleanTitle,
    tokens,
    titleSimilarity,
    vsPair,
    samePair,
    stage,
    disciplines,
    parseAgo,
    parseDuration,
    extractJson,
  };
})();
