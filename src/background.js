// Service worker: opens the cinema tab and looks up shared rooms.

const REGISTRY = 'https://raw.githubusercontent.com/Beetlejuice8921/videoroom-rooms/main/';
const INDEX_TTL = 30 * 60 * 1000;
const ROOM_TTL = 30 * 60 * 1000;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'openCinema' && typeof msg.url === 'string') {
    // Content scripts can't open tabs themselves.
    if (msg.url.startsWith(chrome.runtime.getURL('')) || msg.url.startsWith('https://')) {
      chrome.tabs.create({
        url: msg.url,
        index: sender.tab ? sender.tab.index + 1 : undefined,
        openerTabId: sender.tab?.id,
      });
    }
    return false;
  }
  if (msg?.type === 'sharedRoom' && typeof msg.videoId === 'string') {
    sharedRoom(msg.videoId)
      .then((room) => sendResponse({ room }))
      .catch((err) => {
        console.warn('[Videoroom] registry', err);
        sendResponse({ room: null });
      });
    return true; // async response
  }
  return false;
});

// The worker can be stopped at any time, so the cache lives in storage.
async function cached(key, ttl, load) {
  const { [key]: entry } = await chrome.storage.local.get(key);
  if (entry && Date.now() - entry.at < ttl) return entry.data;
  try {
    const data = await load();
    await chrome.storage.local.set({ [key]: { at: Date.now(), data } });
    return data;
  } catch (err) {
    if (entry) return entry.data; // offline: stale is better than nothing
    throw err;
  }
}

async function fetchJson(path) {
  const res = await fetch(REGISTRY + path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function sharedRoom(videoId) {
  const { settings } = await chrome.storage.local.get('settings');
  if (settings?.useShared === false) return null;
  const index = await cached('registry:index', INDEX_TTL, () => fetchJson('index.json'));
  const roomId = index?.videos?.[videoId];
  if (!roomId || !/^r[a-z0-9]{4,30}$/.test(roomId)) return null;
  return cached(`registry:room:${roomId}`, ROOM_TTL, () => fetchJson(`rooms/${roomId}.json`));
}
