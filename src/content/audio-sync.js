// Audio-based offset detection ("Синхронизировать по звуку").
//
// Every camera hears the same event, so their loudness envelopes line up.
// We play each video in the native YouTube player at high speed, tap its
// audio with Web Audio (silenced for the viewer), build a log-energy envelope
// on a 0.1 s grid, cross-correlate envelopes pairwise and keep the most
// confident chain of pairs. Envelopes are cached per video in
// chrome.storage.local, so adding a camera only captures that camera.
(() => {
  'use strict';

  const DT = 0.1; // s, envelope grid
  const RATE = 8; // playback speed while capturing (audio still flows up to 16x)
  const BLOCK = 512; // samples per ScriptProcessor block: ~0.1 s of media at 8x
  const MIN_OVERLAP = 90; // s of common audio required for a pair
  const MIN_RATIO = 1.3; // best peak vs best peak elsewhere (outside ±2 s)
  const CACHE_PREFIX = 'env:';
  const CACHE_VERSION = 1;

  // ---------- pure analysis (no DOM) ----------

  // samples: flat [time, rms, time, rms, ...] → Float32Array on the DT grid.
  function toGrid(samples, duration) {
    const n = Math.max(1, Math.ceil(duration / DT));
    const sum = new Float64Array(n);
    const cnt = new Uint32Array(n);
    for (let i = 0; i < samples.length; i += 2) {
      const k = Math.floor(samples[i] / DT);
      if (k >= 0 && k < n) {
        sum[k] += samples[i + 1];
        cnt[k]++;
      }
    }
    const g = new Float32Array(n);
    let last = -1;
    for (let k = 0; k < n; k++) {
      if (!cnt[k]) continue;
      g[k] = sum[k] / cnt[k];
      if (last < 0) g.fill(g[k], 0, k);
      else for (let j = last + 1; j < k; j++) g[j] = g[last] + ((g[k] - g[last]) * (j - last)) / (k - last);
      last = k;
    }
    if (last >= 0) g.fill(g[last], last + 1);
    return g;
  }

  // Log energy with the slow trend removed (3 s window), standardized.
  // Robust to different mics, gains and room acoustics.
  function features(env) {
    const n = env.length;
    const lg = new Float64Array(n);
    for (let k = 0; k < n; k++) lg[k] = Math.log(env[k] + 1e-4);
    const w = Math.round(1.5 / DT);
    const cs = new Float64Array(n + 1);
    for (let k = 0; k < n; k++) cs[k + 1] = cs[k] + lg[k];
    const f = new Float64Array(n);
    let mean = 0;
    for (let k = 0; k < n; k++) {
      const lo = Math.max(0, k - w);
      const hi = Math.min(n, k + w + 1);
      f[k] = lg[k] - (cs[hi] - cs[lo]) / (hi - lo);
      mean += f[k];
    }
    mean /= n;
    let sd = 0;
    for (let k = 0; k < n; k++) {
      f[k] -= mean;
      sd += f[k] * f[k];
    }
    sd = Math.sqrt(sd / n) || 1;
    for (let k = 0; k < n; k++) f[k] /= sd;
    return f;
  }

  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = ((2 * Math.PI) / len) * (inverse ? 1 : -1);
      const wr = Math.cos(ang);
      const wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1;
        let ci = 0;
        for (let j = 0; j < half; j++) {
          const a = i + j;
          const b = a + half;
          const vr = re[b] * cr - im[b] * ci;
          const vi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - vr;
          im[b] = im[a] - vi;
          re[a] += vr;
          im[a] += vi;
          const t = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = t;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) (re[i] /= n), (im[i] /= n);
  }

  // Finds lag L (seconds) such that a(t) ≈ b(t − L): what happens at time t in
  // video B happens at t + L in video A, i.e. offset(B) = offset(A) + L.
  function correlate(a, b) {
    let n = 1;
    while (n < a.length + b.length) n <<= 1;
    const ar = new Float64Array(n);
    const ai = new Float64Array(n);
    const br = new Float64Array(n);
    const bi = new Float64Array(n);
    ar.set(a);
    br.set(b);
    fft(ar, ai, false);
    fft(br, bi, false);
    for (let i = 0; i < n; i++) {
      const re = ar[i] * br[i] + ai[i] * bi[i];
      const im = ai[i] * br[i] - ar[i] * bi[i];
      ar[i] = re;
      ai[i] = im;
    }
    fft(ar, ai, true);

    const minOv = Math.round(MIN_OVERLAP / DT);
    const scores = new Map();
    let best = -Infinity;
    let bestK = 0;
    for (let k = -(b.length - minOv); k <= a.length - minOv; k++) {
      const overlap = Math.min(a.length, b.length + k) - Math.max(0, k);
      if (overlap < minOv) continue;
      const s = ar[(k + n) % n] / overlap;
      scores.set(k, s);
      if (s > best) {
        best = s;
        bestK = k;
      }
    }
    if (!scores.size) return null;
    let second = -Infinity;
    const guard = Math.round(2 / DT);
    for (const [k, s] of scores) if (Math.abs(k - bestK) > guard && s > second) second = s;
    const y0 = scores.get(bestK - 1) ?? best;
    const y2 = scores.get(bestK + 1) ?? best;
    const den = y0 - 2 * best + y2;
    const frac = den ? (0.5 * (y0 - y2)) / den : 0;
    return {
      lag: (bestK + frac) * DT,
      score: best,
      ratio: second > 0 ? best / second : Infinity,
    };
  }

  // envelopes: { videoId: Float32Array }. Returns offsets relative to `anchor`
  // (whose offset stays fixed) via the most confident spanning tree of pairs.
  function solveOffsets(envelopes, anchor) {
    const ids = Object.keys(envelopes);
    const feats = Object.fromEntries(ids.map((id) => [id, features(envelopes[id])]));
    const edges = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const r = correlate(feats[ids[i]], feats[ids[j]]);
        if (r && r.ratio >= MIN_RATIO) edges.push({ a: ids[i], b: ids[j], ...r });
      }
    }
    edges.sort((x, y) => y.ratio - x.ratio);

    // Prim-like growth from the anchor, always taking the most confident edge.
    const rel = { [anchor]: 0 };
    const confidence = { [anchor]: Infinity };
    let grown = true;
    while (grown) {
      grown = false;
      for (const e of edges) {
        const hasA = e.a in rel;
        const hasB = e.b in rel;
        if (hasA === hasB) continue;
        if (hasA) {
          rel[e.b] = rel[e.a] + e.lag;
          confidence[e.b] = e.ratio;
        } else {
          rel[e.a] = rel[e.b] - e.lag;
          confidence[e.a] = e.ratio;
        }
        grown = true;
        break;
      }
    }
    return { rel, confidence, edges };
  }

  // ---------- envelope cache ----------

  function encodeEnv(env) {
    // log-energy quantized to bytes: plenty for correlation, ~11 KB per 18 min.
    const bytes = new Uint8Array(env.length);
    for (let k = 0; k < env.length; k++) {
      const v = Math.log10(env[k] + 1e-4); // -4 .. 0
      bytes[k] = Math.max(0, Math.min(255, Math.round(((v + 4) / 4) * 255)));
    }
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function decodeEnv(b64) {
    const s = atob(b64);
    const env = new Float32Array(s.length);
    for (let k = 0; k < s.length; k++) env[k] = Math.pow(10, (s.charCodeAt(k) / 255) * 4 - 4) - 1e-4;
    return env;
  }

  async function loadCachedEnv(videoId) {
    const key = CACHE_PREFIX + videoId;
    const { [key]: entry } = await chrome.storage.local.get(key);
    return entry && entry.v === CACHE_VERSION && entry.dt === DT ? decodeEnv(entry.data) : null;
  }

  async function saveCachedEnv(videoId, env) {
    await chrome.storage.local.set({
      [CACHE_PREFIX + videoId]: { v: CACHE_VERSION, dt: DT, data: encodeEnv(env), at: Date.now() },
    });
  }

  // ---------- capture in the native player ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // One graph per page: once a <video> is routed into an AudioContext it can't
  // be routed back, so the context stays alive and passes audio through.
  let graph = null;
  function ensureGraph(video) {
    if (graph && graph.video === video) return graph;
    const ctx = new AudioContext();
    const src = ctx.createMediaElementSource(video);
    const out = ctx.createGain(); // viewer's audio; 0 while capturing
    const tap = ctx.createScriptProcessor(BLOCK, 1, 1);
    src.connect(out);
    out.connect(ctx.destination);
    src.connect(tap);
    tap.connect(ctx.destination); // outputs silence, but must be connected to run
    graph = { ctx, src, out, tap, video, onBlock: null };
    tap.onaudioprocess = (e) => graph.onBlock?.(e.inputBuffer.getChannelData(0));
    return graph;
  }

  class Capture {
    // deps: { video, playerEl, load(videoId, start), nativeVideoId(), onProgress(info) }
    constructor(deps) {
      this.d = deps;
      this.cancelled = false;
    }

    cancel() {
      this.cancelled = true;
    }

    async envelope(videoId, label) {
      const cached = await loadCachedEnv(videoId);
      if (cached) return cached;

      const { video: v, playerEl } = this.d;
      const g = ensureGraph(v);
      await g.ctx.resume();
      const adShowing = () => playerEl.classList.contains('ad-showing');

      this.d.load(videoId, 0);
      const deadline = Date.now() + 60000;
      while (!(this.d.nativeVideoId() === videoId && !adShowing() && v.readyState >= 2)) {
        if (this.cancelled) throw new Error('cancelled');
        if (Date.now() > deadline) throw new Error(`видео ${videoId} не загрузилось`);
        await sleep(200);
      }

      const samples = [];
      g.out.gain.value = 0;
      g.onBlock = (d) => {
        if (v.paused || v.seeking || v.readyState < 3 || adShowing()) return;
        let s = 0;
        for (let i = 0; i < d.length; i++) s += d[i] * d[i];
        samples.push(v.currentTime, Math.sqrt(s / d.length));
      };
      // Element volume/mute apply before our tap, so capture at full volume.
      const saved = { volume: v.volume, muted: v.muted };
      v.volume = 1;
      v.muted = false;
      v.preservesPitch = false;
      if (v.currentTime > 1) v.currentTime = 0;

      let dur = v.duration;
      try {
        let lastT = -1;
        let stalledMs = 0;
        while (true) {
          if (this.cancelled) throw new Error('cancelled');
          if (this.d.nativeVideoId() !== videoId) {
            // Ran into YouTube's autoplay at the very end: what we have is enough.
            if (Number.isFinite(dur) && lastT >= dur * 0.97) break;
            throw new Error('видео сменилось во время захвата');
          }
          if (!adShowing()) {
            dur = v.duration;
            if (v.playbackRate !== RATE) v.playbackRate = RATE;
            if (v.paused && !v.ended) v.play().catch(() => {});
          }
          // Stop a few seconds early (at 8x that's under a second of real time)
          // so the video never ends and YouTube's autoplay doesn't navigate away.
          if (v.ended || (Number.isFinite(dur) && v.currentTime >= dur - 4)) break;
          const tick = Number.isFinite(dur) && dur - v.currentTime < 15 ? 50 : 250;
          if (Math.abs(v.currentTime - lastT) < 0.01) {
            if ((stalledMs += tick) > 30000) throw new Error(`видео ${videoId} зависло`);
          } else stalledMs = 0;
          lastT = v.currentTime;
          this.d.onProgress?.({ videoId, label, pos: v.currentTime, dur });
          await sleep(tick);
        }
      } finally {
        g.onBlock = null;
        v.pause();
        v.playbackRate = 1;
        v.preservesPitch = true;
        v.volume = saved.volume;
        v.muted = saved.muted;
        g.out.gain.value = 1;
      }

      const env = toGrid(samples, dur);
      await saveCachedEnv(videoId, env);
      return env;
    }
  }

  globalThis.VRAudioSync = { Capture, solveOffsets, correlate, features, toGrid, encodeEnv, decodeEnv, DT, RATE };
})();
