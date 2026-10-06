// Offline tuning of the audio check on envelopes from collect-envelopes.js.
// Compares the excerpt method (A) with chunk clustering (B) on labelled data.
// Usage: node tools/tune-check.js
'use strict';

const fs = require('fs');
const path = require('path');

globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
require('../src/content/audio-sync.js');
const A = globalThis.VRAudioSync;
const DT = A.DT;

const dataDir = path.join(__dirname, 'data');
const sets = fs.readdirSync(dataDir).filter((f) => f.startsWith('envelopes-')).map((f) => ({ name: f.slice(10, -5), ...JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')) }));

// A: three 60 s excerpts at 30/55/80 %, two must agree within 0.5 s.
function methodA(seedEnv, env) {
  const dur = env.length * DT;
  const len = Math.min(60, Math.max(20, dur / 4));
  const offs = [];
  for (const f of [0.3, 0.55, 0.8]) {
    const start = Math.max(0, Math.min(dur * f, dur - len - 5));
    const k0 = Math.round(start / DT);
    const ex = Float32Array.from(env.slice(k0, k0 + Math.round(len / DT)));
    const m = A.matchExcerpt(seedEnv, ex, start);
    if (!m) continue;
    if (offs.some((o) => Math.abs(o - m.offset) < 0.5)) return { ok: true, offset: m.offset };
    offs.push(m.offset);
  }
  return { ok: false };
}

// B: the extension's chunk clustering (whole candidate captured).
function methodB(seedEnv, env) {
  const hits = A.chunkHits(A.features(seedEnv), env, 0);
  const best = A.clusterHits(hits);
  const rest = hits.filter((h) => Math.abs(h.offset - best.offset) > 2);
  return { ...best, second: A.clusterHits(rest).size, chunks: hits.length };
}

for (const set of sets) {
  const seedEnv = Float32Array.from(set.env[set.seed] || []);
  console.log(`\n=== ${set.name}: seed ${set.seed} (${(seedEnv.length * DT).toFixed(0)} s)`);
  for (const [id, label] of Object.entries(set.labels)) {
    const env = set.env[id];
    if (!env) {
      console.log(`  ${id} ${['-', '+', '?'][label]}  (нет данных)`);
      continue;
    }
    const e = Float32Array.from(env);
    const a = methodA(seedEnv, e);
    const b = methodB(seedEnv, e);
    console.log(
      `  ${id} ${['-', '+', '?'][label]} ${String(Math.round(e.length * DT)).padStart(4)} s | A: ${a.ok ? '✓ ' + a.offset.toFixed(1) : '✗'} | ` +
        `B: группа ${b.size} (вторая ${b.second}, кусков ${b.chunks}) сдвиг ${b.offset?.toFixed(1)} → ${b.size >= 5 ? '✓' : b.size >= 3 ? '?' : '✗'}`
    );
  }
}
