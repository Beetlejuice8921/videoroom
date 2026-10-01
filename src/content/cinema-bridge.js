// Runs on the hosted cinema page (GitHub Pages). The page itself has no
// chrome.* APIs, so it reaches the extension's room storage through us.
// Protocol: page posts { vrCinema: 'request', id, op, ... }, we answer with
// { vrCinema: 'response', id, result | error }; storage changes are pushed as
// { vrCinema: 'roomChanged', room }.
(() => {
  'use strict';

  const VR = globalThis.VR;
  let watchedRoomId = null;

  function reply(id, payload) {
    window.postMessage({ vrCinema: 'response', id, ...payload }, location.origin);
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const msg = e.data;
    if (!msg || msg.vrCinema !== 'request') return;
    try {
      switch (msg.op) {
        case 'hello':
          return reply(msg.id, { result: { version: chrome.runtime.getManifest().version } });
        case 'loadRoom': {
          const rooms = await VR.loadRooms();
          watchedRoomId = msg.roomId;
          return reply(msg.id, { result: rooms[msg.roomId] || null });
        }
        case 'saveRoom': {
          const room = VR.normalizeRoom(msg.room);
          if (!room) throw new Error('invalid room');
          const rooms = await VR.loadRooms();
          // Only update rooms that exist in this browser; the page can't create new ones.
          if (!rooms[room.id]) throw new Error('unknown room');
          const saved = await VR.saveRoom(room);
          return reply(msg.id, { result: { updatedAt: saved.updatedAt } });
        }
        default:
          throw new Error('unknown op ' + msg.op);
      }
    } catch (err) {
      reply(msg.id, { error: String(err && err.message ? err.message : err) });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.rooms || !watchedRoomId) return;
    const room = changes.rooms.newValue?.[watchedRoomId];
    if (room) window.postMessage({ vrCinema: 'roomChanged', room }, location.origin);
  });
})();
