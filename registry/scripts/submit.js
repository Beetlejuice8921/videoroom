// Validates a submitted room and writes it into the registry.
// Runs in GitHub Actions (see .github/workflows/submit.yml).
//
// Input (env): ROOM_JSON (manual dispatch) or ISSUE_BODY (issue with a ```json block),
//              SUBMITTER (GitHub login), REPO_OWNER.
// Output: rooms/<id>.json, index.json, and .result.md / .result-title / .result-ok
//         for the workflow to commit and reply with.
'use strict';

const fs = require('fs');
const path = require('path');

globalThis.chrome = undefined;
require('./rooms.js'); // same room model as the extension (copied from src/shared)
const VR = globalThis.VR;

const ROOT = path.join(__dirname, '..');
const MAX_CAMERAS = 12;

function finish(ok, title, body) {
  fs.writeFileSync(path.join(ROOT, '.result.md'), body + '\n');
  fs.writeFileSync(path.join(ROOT, '.result-title'), title);
  if (ok) fs.writeFileSync(path.join(ROOT, '.result-ok'), '1');
  console.log(body);
  process.exit(ok ? 0 : 1);
}

function camerasLabel(n) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ракурс`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ракурса`;
  return `${n} ракурсов`;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const submitter = process.env.SUBMITTER || 'unknown';
const repoOwner = process.env.REPO_OWNER || '';
let raw = process.env.ROOM_JSON || '';
if (!raw.trim()) {
  const body = process.env.ISSUE_BODY || '';
  const m = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  raw = m ? m[1] : body;
}

let input;
try {
  input = JSON.parse(raw);
} catch {
  finish(false, 'invalid', '❌ Не удалось прочитать JSON комнаты. Вставьте его в блок ```json … ```.');
}

const room = VR.normalizeRoom(input);
if (!room) finish(false, 'invalid', '❌ В комнате нет ни одного распознанного YouTube-видео.');
if (room.cameras.length < 2) finish(false, 'invalid', '❌ В общей комнате должно быть хотя бы два ракурса.');
if (room.cameras.length > MAX_CAMERAS) finish(false, 'invalid', `❌ Слишком много ракурсов (максимум ${MAX_CAMERAS}).`);
if (!/^r[a-z0-9]{4,30}$/.test(String(input.id || ''))) room.id = VR.newRoomId();

const indexFile = path.join(ROOT, 'index.json');
const index = readJson(indexFile, { version: 1, videos: {}, rooms: {} });
const existing = index.rooms[room.id];
if (existing && existing.owner !== submitter && submitter !== repoOwner) {
  finish(false, 'denied', `❌ Комнату «${existing.name}» опубликовал @${existing.owner}; изменить её может только автор.`);
}

const conflicts = room.cameras.filter((c) => index.videos[c.videoId] && index.videos[c.videoId] !== room.id);
if (conflicts.length) {
  const list = conflicts.map((c) => `- \`${c.videoId}\` уже в комнате «${index.rooms[index.videos[c.videoId]]?.name}»`).join('\n');
  finish(false, 'conflict', `❌ Некоторые видео уже есть в других общих комнатах:\n${list}`);
}

// Re-map this room's videos (cameras may have been removed in an update).
for (const [vid, rid] of Object.entries(index.videos)) if (rid === room.id) delete index.videos[vid];
for (const c of room.cameras) index.videos[c.videoId] = room.id;

const owner = existing?.owner || submitter;
const updated = new Date().toISOString();
const { id, name, audioMode, cameras, stage } = room;
fs.mkdirSync(path.join(ROOT, 'rooms'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'rooms', `${id}.json`), JSON.stringify({ id, name, audioMode, cameras, stage, owner, updated }, null, 2) + '\n');
index.rooms[id] = { name, cameras: cameras.length, owner, updated };
fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n');

finish(
  true,
  name,
  `✅ Комната «${name}» ${existing ? 'обновлена' : 'опубликована'} (${camerasLabel(cameras.length)}, id \`${id}\`).\n` +
    'Расширение Videoroom подхватит её у других зрителей в течение ~30 минут.'
);
