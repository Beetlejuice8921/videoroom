// Videoroom content script for youtube.com.
//
// YouTube refuses to play its embeds inside youtube.com pages (error 152),
// so here cameras are switched in the native player itself via
// loadVideoById (~1 s), with a thumbnail poster masking the gap. Instant
// switching with a warm pool lives in the cinema page (src/room).
(() => {
  'use strict';

  const VR = globalThis.VR;

  const TICK_INTERVAL = 500; // ms
  const SWITCH_TIMEOUT = 10000; // ms
  const LOAD_LEAD_DEFAULT = 1.0; // s, initial guess of loadVideoById latency
  const RESYNC_AFTER_SWITCH = 0.4; // s, correct the landing position if off by more
  const SAVE_DEBOUNCE = 1000; // ms

  // Up = towards the stage on the venue map (arranged in the cinema).
  const WASD = { KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right' };

  let session = null;
  let refreshSeq = 0;

  // ---------- helpers ----------

  // youtube.com enforces Trusted Types, so build DOM without innerHTML.
  function h(tag, props, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) if (c != null && c !== false) e.append(c);
    return e;
  }

  function fmtTime(s) {
    s = Math.max(0, Math.round(s));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Calls into page-bridge.js (MAIN world). Synchronous under the hood.
  let bridgeSeq = 0;
  function bridge(cmd, args = {}) {
    const id = ++bridgeSeq;
    let reply = { error: 'no response from page bridge' };
    const onResponse = (e) => {
      try {
        const r = JSON.parse(e.detail);
        if (r.id === id) reply = r;
      } catch {
        // ignore foreign events
      }
    };
    document.addEventListener('videoroom:response', onResponse);
    document.dispatchEvent(new CustomEvent('videoroom:request', { detail: JSON.stringify({ id, cmd, args }) }));
    document.removeEventListener('videoroom:response', onResponse);
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  }

  function nativeVideoId() {
    try {
      return bridge('videoId');
    } catch {
      return null;
    }
  }

  function pageVideoId() {
    if (location.pathname !== '/watch') return null;
    return VR.parseVideoId(new URLSearchParams(location.search).get('v') || '');
  }

  function waitForElements(seq) {
    return new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        if (seq !== refreshSeq) return resolve(null);
        const player = document.querySelector('#movie_player');
        const video = player?.querySelector('video.html5-main-video');
        const below = document.querySelector('ytd-watch-flexy #below');
        if (player && video && below) return resolve({ player, video, below });
        if (Date.now() - started > 20000) return resolve(null);
        setTimeout(check, 250);
      };
      check();
    });
  }

  // ---------- session ----------

  class RoomSession {
    constructor(room, pageVid, { player, video, below }) {
      this.room = room;
      this.pageVideoId = pageVid;
      this.playerEl = player;
      this.video = video;
      this.active = nativeVideoId() || pageVid; // what the native player shows
      this.switchSeq = 0;
      this.switching = false;
      this.loadLead = LOAD_LEAD_DEFAULT;

      this.poster = h('div', { class: 'vr-poster' });
      this.toastEl = h('div', { class: 'vr-toast' });
      this.stage = h('div', { class: 'vr-stage' }, this.poster, this.toastEl);
      const videoContainer = player.querySelector('.html5-video-container');
      if (videoContainer) videoContainer.after(this.stage);
      else player.appendChild(this.stage);

      this.strip = h('div', { class: 'vr-strip' });
      below.prepend(this.strip);
      this.strip.addEventListener('click', (e) => this.onStripClick(e));

      this.timer = setInterval(() => this.tick(), TICK_INTERVAL);
      this.renderStrip();
    }

    // ----- model -----

    cam(id) {
      return this.room.cameras.find((c) => c.videoId === id) || null;
    }

    camIndex(id) {
      return this.room.cameras.findIndex((c) => c.videoId === id);
    }

    camLabel(cam) {
      return cam.label || `Камера ${this.camIndex(cam.videoId) + 1}`;
    }

    timeline() {
      return this.video.currentTime + (this.cam(this.active)?.offset || 0);
    }

    // Seconds into `cam` that match the current moment, or a reason it can't play.
    targetFor(cam) {
      const t = this.timeline() - cam.offset;
      if (t < 0) return { t, off: `начнётся через ${fmtTime(-t)}` };
      if (cam.duration && t > cam.duration - 0.5) return { t, off: 'запись уже закончилась' };
      return { t };
    }

    adShowing() {
      return this.playerEl.classList.contains('ad-showing');
    }

    setRoom(room) {
      if (this.saveTimer || room.updatedAt === this.savedAt) return;
      this.room = room;
      this.renderStrip();
    }

    scheduleSave() {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(async () => {
        this.saveTimer = null;
        const saved = await VR.saveRoom(this.room);
        this.savedAt = saved.updatedAt;
      }, SAVE_DEBOUNCE);
    }

    // ----- switching -----

    async switchTo(id) {
      const cam = this.cam(id);
      if (!cam || id === this.active) return;
      if (this.syncCapture) return this.toast('Идёт синхронизация по звуку');
      if (this.adShowing()) return this.toast('Дождитесь окончания рекламы');
      const target = this.targetFor(cam);
      if (target.off) return this.toast(`${this.camLabel(cam)}: ${target.off}`);

      const v = this.video;
      const seq = ++this.switchSeq;
      const wasPlaying = !v.paused && !v.ended;
      const rate = v.playbackRate;
      const t0 = performance.now();
      const timeline0 = this.timeline();

      this.active = id;
      this.switching = true;
      this.showPoster(cam);
      this.renderStrip();
      this.toast(`${this.camIndex(id) + 1} · ${this.camLabel(cam)}`);

      try {
        bridge('load', { videoId: id, start: Math.max(0, target.t + (wasPlaying ? this.loadLead * rate : 0)) });
      } catch (err) {
        console.warn('[Videoroom] load failed', err);
        this.switching = false;
        this.hidePoster();
        return this.toast('Не удалось переключить ракурс');
      }

      const arrived = await this.waitForArrival(id, seq, wasPlaying);
      if (seq !== this.switchSeq) return;
      this.switching = false;
      if (!arrived) {
        this.hidePoster();
        return this.toast('Ракурс долго загружается');
      }

      const elapsed = (performance.now() - t0) / 1000;
      if (wasPlaying) {
        // Learn the real latency so the next switch lands closer.
        this.loadLead = Math.min(3, Math.max(0.3, this.loadLead * 0.5 + elapsed * 0.5));
      } else {
        v.pause();
      }
      const expected = timeline0 + (wasPlaying ? elapsed * rate : 0) - cam.offset;
      if (Math.abs(v.currentTime - expected) > RESYNC_AFTER_SWITCH) {
        try {
          bridge('seek', { t: expected });
        } catch {
          v.currentTime = expected;
        }
      }
      this.hidePoster();
    }

    async waitForArrival(id, seq, wantPlaying) {
      const v = this.video;
      const deadline = performance.now() + SWITCH_TIMEOUT;
      while (performance.now() < deadline) {
        if (seq !== this.switchSeq) return false;
        if (
          !this.adShowing() &&
          nativeVideoId() === id &&
          v.readyState >= 3 &&
          !v.seeking &&
          (!wantPlaying || !v.paused)
        ) {
          return true;
        }
        await sleep(40);
      }
      return false;
    }

    step(dir) {
      const ids = this.room.cameras.map((c) => c.videoId);
      if (ids.length < 2) return;
      const i = ids.indexOf(this.active);
      this.switchTo(ids[(i + dir + ids.length) % ids.length]);
    }

    // ----- audio sync -----

    async syncByAudio() {
      if (this.syncCapture) return this.syncCapture.cancel();
      const AS = globalThis.VRAudioSync;
      const cams = this.room.cameras;
      if (cams.length < 2) return this.toast('Нужно хотя бы два ракурса');
      if (this.adShowing()) return this.toast('Дождитесь окончания рекламы');

      const known = cams.reduce((s, c) => s + (c.duration || 600), 0);
      const minutes = Math.max(1, Math.round(known / AS.RATE / 60));
      if (
        !window.confirm(
          `Videoroom прослушает все ${cams.length} ракурса на ускорении ${AS.RATE}× (без звука) и подберёт сдвиги.\n` +
            `Это займёт до ~${minutes} мин; уже прослушанные видео берутся из кэша.\n\nНачать?`
        )
      ) {
        return;
      }

      const v = this.video;
      const back = { id: this.active, t: v.currentTime, paused: v.paused };
      let volume = null;
      try {
        volume = bridge('getVolume'); // capture runs at full volume; YouTube may remember it
      } catch {
        // restore what we can from the element later
      }
      const anchor = cams[0];
      const capture = new AS.Capture({
        video: v,
        playerEl: this.playerEl,
        load: (videoId, start) => bridge('load', { videoId, start }),
        nativeVideoId,
        onProgress: ({ label, pos, dur }) => {
          const pct = Number.isFinite(dur) && dur > 0 ? Math.round((pos / dur) * 100) : 0;
          this.setPosterText(`Синхронизация по звуку · ${label}`, `${this.syncStep} · ${pct}%`);
        },
      });
      this.syncCapture = capture;
      this.switching = true; // pause tick bookkeeping
      this.renderStrip();
      this.showPoster(cams[0]);

      let message;
      try {
        const envs = {};
        for (const [i, cam] of cams.entries()) {
          this.syncStep = `ракурс ${i + 1} из ${cams.length}`;
          this.setPosterText(`Синхронизация по звуку · ${this.camLabel(cam)}`, this.syncStep);
          envs[cam.videoId] = await capture.envelope(cam.videoId, this.camLabel(cam));
          if (!cam.duration) cam.duration = VR.round2(envs[cam.videoId].length * AS.DT);
        }
        this.setPosterText('Синхронизация по звуку', 'Сравниваю звук…');
        await sleep(30);
        const { rel } = AS.solveOffsets(envs, anchor.videoId);
        const failed = [];
        for (const cam of cams) {
          if (cam === anchor) continue;
          if (rel[cam.videoId] == null) failed.push(this.camLabel(cam));
          else cam.offset = VR.round2(anchor.offset + rel[cam.videoId]);
        }
        this.scheduleSave();
        const ok = cams.length - 1 - failed.length;
        message = failed.length
          ? `Синхронизировано ${ok} из ${cams.length - 1}. Не нашлось общего звука: ${failed.join(', ')}`
          : `Готово: все ${cams.length} ракурса синхронизированы`;
      } catch (err) {
        message = err.message === 'cancelled' ? 'Синхронизация остановлена' : `Ошибка синхронизации: ${err.message}`;
        console.warn('[Videoroom]', err);
      } finally {
        this.syncCapture = null;
        // Return to what the viewer was watching.
        try {
          bridge('load', { videoId: back.id, start: back.t });
        } catch {
          // ignore
        }
        this.active = back.id;
        await this.waitForArrival(back.id, this.switchSeq, false);
        if (back.paused) v.pause();
        if (volume) {
          try {
            bridge('setVolume', volume);
          } catch {
            // ignore
          }
        }
        this.switching = false;
        this.hidePoster();
        this.renderStrip();
      }
      this.toast(message);
    }

    setPosterText(title, note) {
      this.poster.textContent = '';
      this.poster.append(h('div', { class: 'vr-spinner' }), h('div', { text: title }), h('div', { class: 'vr-poster-note', text: note || '' }));
      this.poster.classList.add('vr-show');
    }

    openCinema() {
      const v = this.video;
      const hash = VR.encodeRoomHash({ room: this.room, cam: this.active, t: this.timeline() });
      v.pause();
      VR.cinemaUrl()
        .then((base) => chrome.runtime.sendMessage({ type: 'openCinema', url: base + hash }))
        .catch((err) => {
          console.warn('[Videoroom]', err);
          this.toast('Расширение обновилось — перезагрузите страницу');
        });
    }

    // ----- periodic -----

    tick() {
      if (this.switching) return;
      // Follow changes we didn't make (e.g. YouTube's own navigation).
      const id = nativeVideoId();
      if (id && id !== this.active && this.cam(id)) {
        this.active = id;
        this.renderStrip();
      }
      this.learnDuration();
      this.updateStripStatus();
    }

    learnDuration() {
      const cam = this.cam(this.active);
      const d = this.video.duration;
      if (!cam || this.adShowing() || !Number.isFinite(d) || d <= 0) return;
      if (nativeVideoId() !== this.active) return;
      if (!cam.duration || Math.abs(cam.duration - d) > 1) {
        cam.duration = VR.round2(d);
        this.scheduleSave();
      }
    }

    // ----- UI -----

    toast(text) {
      this.toastEl.textContent = text;
      this.toastEl.classList.add('vr-show');
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => this.toastEl.classList.remove('vr-show'), 1800);
    }

    showPoster(cam) {
      this.poster.textContent = '';
      this.poster.style.backgroundImage = `url("${VR.thumbUrl(cam.videoId, 'hqdefault')}")`;
      this.poster.append(h('div', { class: 'vr-spinner' }), h('div', { text: this.camLabel(cam) }));
      this.poster.classList.add('vr-show');
    }

    hidePoster() {
      this.poster.classList.remove('vr-show');
    }

    renderStrip() {
      const s = this.strip;
      s.textContent = '';
      const head = h(
        'div',
        { class: 'vr-head' },
        h('span', { class: 'vr-title', text: `🎥 ${this.room.name}` }),
        h('span', { class: 'vr-hint', text: '1–9, Q / E, WASD — ракурсы' }),
        h('span', { class: 'vr-spacer' }),
        h('button', {
          class: 'vr-btn',
          dataset: { sync: '1' },
          title: 'Подобрать сдвиги ракурсов автоматически, сравнив их звук',
          text: this.syncCapture ? '✕ Остановить синхронизацию' : '🎚 Синхронизировать по звуку',
        }),
        h('button', {
          class: 'vr-btn vr-btn-accent',
          dataset: { cinema: '1' },
          title: 'Все ракурсы заранее загружены — переключение без задержки',
          text: '🎬 Кинозал',
        })
      );

      this.cards = new Map();
      const list = h('div', { class: 'vr-cams' });
      this.room.cameras.forEach((cam, i) => {
        const card = h(
          'button',
          { class: 'vr-cam', dataset: { cam: cam.videoId } },
          h('img', { src: VR.thumbUrl(cam.videoId), alt: '', loading: 'lazy' }),
          h('span', { class: 'vr-num', text: String(i + 1) }),
          h('span', { class: 'vr-label', text: this.camLabel(cam) })
        );
        this.cards.set(cam.videoId, card);
        list.append(card);
      });

      s.append(head, list);
      this.updateStripStatus();
    }

    updateStripStatus() {
      if (!this.cards) return;
      for (const [id, card] of this.cards) {
        const cam = this.cam(id);
        const off = id === this.active ? null : this.targetFor(cam).off;
        card.classList.toggle('vr-active', id === this.active);
        card.classList.toggle('vr-off', !!off);
        card.title = this.camLabel(cam) + (off ? ` — ${off}` : '');
      }
    }

    onStripClick(e) {
      const btn = e.target.closest('button');
      if (!btn || !this.strip.contains(btn)) return;
      if (btn.dataset.cam) this.switchTo(btn.dataset.cam);
      else if (btn.dataset.cinema) this.openCinema();
      else if (btn.dataset.sync) this.syncByAudio();
    }

    onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;

      let handled = false;
      if (/^Digit[1-9]$/.test(e.code)) {
        const idx = Number(e.code.slice(5)) - 1;
        // Digits beyond the camera count keep YouTube's "seek to N0%".
        if (idx < this.room.cameras.length) {
          this.switchTo(this.room.cameras[idx].videoId);
          handled = true;
        }
      } else if (e.code === 'KeyQ' || e.code === 'KeyE') {
        this.step(e.code === 'KeyE' ? 1 : -1);
        handled = true;
      } else if (WASD[e.code]) {
        const id = VR.pickDirection(this.room, this.active, WASD[e.code]);
        if (id) this.switchTo(id);
        else this.toast('В этом направлении камер нет');
        handled = true;
      }
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }

    destroy() {
      this.syncCapture?.cancel();
      this.switchSeq++;
      clearInterval(this.timer);
      clearTimeout(this.toastTimer);
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        VR.saveRoom(this.room);
      }
      this.stage.remove();
      this.strip.remove();
    }
  }

  // ---------- lifecycle ----------

  async function refresh() {
    const seq = ++refreshSeq;
    const vid = pageVideoId();
    let room = null;
    if (vid) {
      try {
        room = VR.findRoomByVideo(await VR.loadRooms(), vid);
      } catch (err) {
        // Extension was reloaded; this content script is orphaned.
        console.warn('[Videoroom]', err);
        return;
      }
    }
    if (seq !== refreshSeq) return;

    if (session && room && session.pageVideoId === vid && session.room.id === room.id) {
      session.setRoom(room);
      return;
    }
    session?.destroy();
    session = null;
    if (!room) return;

    const els = await waitForElements(seq);
    if (!els || seq !== refreshSeq) return;
    session = new RoomSession(room, vid, els);
  }

  // Capture phase on window so we run before YouTube's own hotkeys.
  window.addEventListener('keydown', (e) => session?.onKey(e), true);
  document.addEventListener('yt-navigate-finish', refresh);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.rooms) refresh();
  });
  refresh();
})();
