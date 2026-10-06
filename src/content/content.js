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
    constructor(room, pageVid, { player, video, below }, { shared = false } = {}) {
      this.room = room;
      this.shared = shared; // from the public registry; becomes a local copy on first save
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

      this.map = new globalThis.VRVenueMap({
        getRoom: () => this.room,
        getActive: () => this.active,
        isUnavailable: (id) => id !== this.active && !!this.targetFor(this.cam(id)).off,
        label: (cam) => this.camLabel(cam),
        onSelect: (id) => this.switchTo(id),
        onMove: (id, pos) => {
          this.cam(id).pos = pos;
          this.scheduleSave();
        },
        onStageMove: (pos) => {
          this.room.stage = pos;
          this.scheduleSave();
        },
        onEditToggle: (on) => this.toast(on ? 'Перетащите камеры и сцену туда, где они были. ✎ — готово' : 'Расстановка сохранена'),
      });

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
      this.maybeOfferSync();
    }

    // New cameras arrive with offset 0, so offer to find real offsets by audio.
    maybeOfferSync() {
      if (!this.syncAfterUpdate) return;
      this.syncAfterUpdate = false;
      setTimeout(() => this.syncByAudio(), 300);
    }

    scheduleSave() {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(async () => {
        this.saveTimer = null;
        const saved = await VR.saveRoom(this.room);
        this.savedAt = saved.updatedAt;
        if (this.shared) {
          this.shared = false; // now a local copy
          this.renderStrip();
        }
      }, SAVE_DEBOUNCE);
    }

    // ----- switching -----

    async switchTo(id) {
      const cam = this.cam(id);
      if (!cam || id === this.active) return;
      if (this.syncCapture || takeover) return this.toast('Идёт анализ звука — подождите');
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
      if (this.switching || takeover) return;
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
        h('span', { class: 'vr-title', text: `${this.shared ? '🌐' : '🎥'} ${this.room.name}` }),
        this.shared && h('span', { class: 'vr-hint', text: 'общая комната · ваши изменения сохранятся как личная копия' }),
        h('span', { class: 'vr-hint', text: '1–9, Q / E, WASD — ракурсы' }),
        h('span', { class: 'vr-spacer' }),
        h('button', {
          class: 'vr-btn',
          dataset: { search: '1' },
          title: 'Поискать на YouTube другие видео с этого события',
          text: '🔍 Найти ракурсы',
        }),
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

      s.append(head, h('div', { class: 'vr-row' }, this.map.el, list));
      if (this.searchEl) s.append(this.searchEl);
      this.map.render();
      this.updateStripStatus();
    }

    toggleSearch() {
      if (this.searchEl) {
        this.searchEl.remove();
        this.searchEl = null;
        return;
      }
      this.searchEl = searchPanel({
        videoId: this.active,
        room: this.room,
        player: { playerEl: this.playerEl, video: this.video },
        onDone: (added, roomId, allVerified) => {
          this.searchEl = null;
          // New cameras without verified offsets: offer audio sync once the room arrives.
          if (added && !allVerified) this.syncAfterUpdate = true;
        },
      });
      this.strip.append(this.searchEl);
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
      this.map.update();
    }

    onStripClick(e) {
      const btn = e.target.closest('button');
      if (!btn || !this.strip.contains(btn)) return;
      if (btn.dataset.cam) this.switchTo(btn.dataset.cam);
      else if (btn.dataset.cinema) this.openCinema();
      else if (btn.dataset.sync) this.syncByAudio();
      else if (btn.dataset.search) this.toggleSearch();
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

  // ---------- "find other angles" ----------

  let offerSyncForRoom = null; // room created from the finder: offer audio sync once mounted
  let takeover = false; // the native player is busy with an audio check

  // Audio check: candidates are cut into 30 s chunks matched against the seed
  // (see chunkHits in audio-sync.js); a group of chunks agreeing on one offset
  // confirms the angle. Tuned with tools/tune-check.js on concert fancams
  // (NewJeans, Coldplay) and KOD battles.
  const CHECK_FULL_MAX = 20 * 60; // s: shorter candidates are listened to in full
  const CHECK_LENGTH = 60; // s per excerpt of longer candidates
  const CHECK_POINTS = [0.3, 0.55, 0.8]; // where to listen in long candidates
  const CHECK_MAX = 12; // candidates checked per run
  // Other events reached 3 agreeing chunks offline and 4 once live (the same
  // song on another night); real angles usually reach 6–10.
  const GROUP_OK = 5; // agreeing chunks for "same audio"
  const GROUP_MAYBE = 3;

  // Borrows the native player for a capture and puts everything back after:
  // the video, position, play state and the user's YouTube volume.
  async function withPlayer({ playerEl, video }, run) {
    const back = { id: nativeVideoId(), t: video.currentTime, paused: video.paused };
    let volume = null;
    try {
      volume = bridge('getVolume');
    } catch {
      // keep going; the element's own volume is restored by the capture
    }
    const title = h('div');
    const note = h('div', { class: 'vr-poster-note' });
    const overlay = h('div', { class: 'vr-stage' }, h('div', { class: 'vr-poster vr-show' }, h('div', { class: 'vr-spinner' }), title, note));
    const container = playerEl.querySelector('.html5-video-container');
    if (container) container.after(overlay);
    else playerEl.append(overlay);
    const setStatus = (t, n = '') => {
      title.textContent = t;
      note.textContent = n;
    };

    takeover = true;
    try {
      return await run(setStatus);
    } finally {
      try {
        if (back.id) bridge('load', { videoId: back.id, start: back.t });
        const until = performance.now() + 10000;
        while (performance.now() < until && !(nativeVideoId() === back.id && video.readyState >= 2)) await sleep(100);
        if (back.paused) video.pause();
        if (volume) bridge('setVolume', volume);
      } catch {
        // best effort
      }
      overlay.remove();
      takeover = false;
    }
  }

  // Results list with checkboxes; adds the picked videos to `room` (or creates one).
  // `player` = { playerEl, video } of the page, used by the audio check.
  function searchPanel({ videoId, room, player, onDone }) {
    const picked = new Set();
    const offsets = new Map(); // videoId → offset found by the audio check
    const rows = new Map(); // videoId → { cb, badge, cand }
    const status = h('div', { class: 'vr-hint', text: 'Ищу видео с этого события…' });
    const list = h('div', { class: 'vr-cands' });
    const doubtTitle = h('div', { class: 'vr-cands-sep', text: 'Сомнительно: похоже на другой баттл или год' });
    const doubtList = h('div', { class: 'vr-cands' });
    const checkBtn = h('button', {
      class: 'vr-btn',
      text: '🎧 Проверить звуком',
      title: 'Сравнить звук кандидатов с этим видео: точно отсеивает чужие события и сразу находит сдвиги',
      disabled: true,
    });
    const addBtn = h('button', { class: 'vr-btn vr-btn-accent', text: 'Добавить выбранные', disabled: true });
    const closeBtn = h('button', { class: 'vr-btn', title: 'Закрыть', text: '✕' });
    const panel = h(
      'div',
      { class: 'vr-search' },
      h(
        'div',
        { class: 'vr-head' },
        h('span', { class: 'vr-title', text: '🔍 Другие ракурсы' }),
        h('span', { class: 'vr-hint', text: 'Отметьте видео с того же события' }),
        h('span', { class: 'vr-spacer' }),
        checkBtn,
        addBtn,
        closeBtn
      ),
      status,
      list
    );
    let info = null;
    let checking = null;

    const refreshAdd = () => {
      addBtn.disabled = !picked.size || !!checking;
      addBtn.textContent = picked.size ? `Добавить выбранные (${picked.size})` : 'Добавить выбранные';
    };
    const setPicked = (id, on) => {
      const row = rows.get(id);
      if (!row || row.cb.disabled) return;
      row.cb.checked = on;
      if (on) picked.add(id);
      else picked.delete(id);
      refreshAdd();
    };

    closeBtn.addEventListener('click', () => {
      checking?.cancel();
      panel.remove();
      onDone(0);
    });

    (async () => {
      try {
        const rooms = await VR.loadRooms();
        const already = new Set(room ? room.cameras.map((c) => c.videoId) : []);
        const res = await globalThis.VRAngleSearch.findAngles(videoId, already, (t) => (status.textContent = t));
        info = res.info;
        const good = res.candidates.filter((c) => !c.doubtful);
        const doubt = res.candidates.filter((c) => c.doubtful);
        status.textContent = res.candidates.length
          ? `Найдено ${good.length}${doubt.length ? ` + ${doubt.length} сомнительных` : ''} (просмотрено ${res.total}). ` +
            'Названия бывают обманчивы — «🎧 Проверить звуком» поможет отсеять чужие видео.'
          : 'Похожих видео не нашлось.';
        for (const c of res.candidates) {
          const other = VR.findRoomByVideo(rooms, c.videoId);
          const busy = !!other && (!room || other.id !== room.id);
          const cb = h('input', { type: 'checkbox', disabled: busy });
          cb.addEventListener('change', () => setPicked(c.videoId, cb.checked));
          const badge = h('span', { class: 'vr-badge' });
          const meta = [c.channel, c.duration ? fmtTime(c.duration) : null, busy ? `уже в комнате «${other.name}»` : null, ...c.why.slice(0, 2)];
          const row = h(
            'label',
            { class: busy ? 'vr-cand vr-cand-busy' : 'vr-cand' },
            cb,
            h('img', { src: VR.thumbUrl(c.videoId), alt: '', loading: 'lazy' }),
            h(
              'span',
              { class: 'vr-cand-info' },
              h('a', { class: 'vr-cand-title', href: `/watch?v=${c.videoId}`, target: '_blank', rel: 'noopener', text: c.title }),
              h('span', { class: 'vr-hint', text: meta.filter(Boolean).join(' · ') }),
              badge
            )
          );
          rows.set(c.videoId, { cb, badge, cand: c, busy });
          (c.doubtful ? doubtList : list).append(row);
        }
        if (doubt.length) panel.append(doubtTitle, doubtList);
        checkBtn.disabled = !res.candidates.length || !player;
      } catch (err) {
        status.textContent = `Поиск не удался: ${err.message}`;
      }
    })();

    checkBtn.addEventListener('click', async () => {
      if (checking) return checking.cancel();
      const AS = globalThis.VRAudioSync;
      const targets = [...rows.values()].filter((r) => !r.busy).slice(0, CHECK_MAX);
      const seedCam = room?.cameras.find((c) => c.videoId === videoId);
      const seedDur = info?.duration || 600;
      const listen = (r) => (r.cand.duration && r.cand.duration <= CHECK_FULL_MAX ? r.cand.duration : CHECK_LENGTH * CHECK_POINTS.length);
      const seconds = seedDur / AS.RATE + targets.reduce((s, r) => s + listen(r) / AS.CHECK_RATE + 2, 0);
      const minutes = Math.max(1, Math.round(seconds / 60));
      if (
        !window.confirm(
          `Videoroom прослушает это видео на ${AS.RATE}× и ${targets.length} кандидатов на ${AS.CHECK_RATE}× (без звука для вас).\n` +
            `Это займёт до ~${minutes} мин; прослушанное раньше берётся из кэша.\n\nНачать?`
        )
      ) {
        return;
      }

      checking = new AS.Capture({
        video: player.video,
        playerEl: player.playerEl,
        load: (id, start) => bridge('load', { videoId: id, start }),
        nativeVideoId,
      });
      checkBtn.textContent = '✕ Остановить проверку';
      refreshAdd();
      let verified = 0;
      try {
        await withPlayer(player, async (setStatus) => {
          checking.d.onProgress = ({ pos, dur }) =>
            setStatus('Проверка звуком · исходное видео', `${Math.round((pos / dur) * 100) || 0}%`);
          setStatus('Проверка звуком · исходное видео');
          const refFeat = AS.features(await checking.envelope(videoId, 'исходное видео'));
          for (const [i, r] of targets.entries()) {
            const c = r.cand;
            const step = `кандидат ${i + 1} из ${targets.length}`;
            setStatus('Проверка звуком', `${step}: ${c.title.slice(0, 60)}`);
            status.textContent = `Проверяю звук: ${step}…`;
            r.badge.textContent = '🎧 слушаю…';
            r.badge.className = 'vr-badge';
            checking.d.onProgress = null;
            const dur = c.duration || 600;
            // Short videos in full; long ones in three excerpts. Stop once the group is big enough.
            const parts =
              dur <= CHECK_FULL_MAX
                ? [[0, Math.max(10, dur - 4)]]
                : CHECK_POINTS.map((f) => [Math.max(0, Math.min(dur * f, dur - CHECK_LENGTH - 5)), CHECK_LENGTH]);
            const hits = [];
            let group = { size: 0, offset: null };
            try {
              for (const [start, len] of parts) {
                hits.push(...AS.chunkHits(refFeat, await checking.excerpt(c.videoId, start, len), start));
                group = AS.clusterHits(hits);
                if (group.size >= GROUP_OK) break;
              }
            } catch (err) {
              if (err.message === 'cancelled') throw err;
              // One video that won't load (long ads, removed, region) must not stop the rest.
              r.badge.textContent = `⚠ не удалось проверить: ${err.message}`;
              r.badge.className = 'vr-badge vr-badge-maybe';
              continue;
            }
            if (group.size >= GROUP_OK) {
              const offset = VR.round2((seedCam?.offset || 0) + group.offset);
              offsets.set(c.videoId, offset);
              r.badge.textContent = `✓ общий звук · сдвиг ${offset >= 0 ? '+' : '−'}${Math.abs(offset).toFixed(1)} с`;
              r.badge.className = 'vr-badge vr-badge-ok';
              setPicked(c.videoId, true);
              verified++;
            } else if (group.size >= GROUP_MAYBE) {
              r.badge.textContent = '? звук похож, но не уверенно (возможно, та же песня в другой день)';
              r.badge.className = 'vr-badge vr-badge-maybe';
            } else {
              // Not proof of another event: the overlap may be too short or too noisy.
              r.badge.textContent = '✗ общий звук не найден';
              r.badge.className = 'vr-badge vr-badge-no';
              setPicked(c.videoId, false);
            }
          }
        });
        status.textContent = `Проверка закончена: ${verified} из ${targets.length} с общим звуком — они отмечены.`;
      } catch (err) {
        status.textContent = err.message === 'cancelled' ? 'Проверка остановлена.' : `Проверка не удалась: ${err.message}`;
      } finally {
        checking = null;
        checkBtn.textContent = '🎧 Проверить звуком';
        refreshAdd();
      }
    });

    addBtn.addEventListener('click', async () => {
      addBtn.disabled = true;
      const target = room
        ? JSON.parse(JSON.stringify(room))
        : { id: VR.newRoomId(), name: eventName(info, videoId), audioMode: 'main', cameras: [{ videoId, label: '', offset: 0 }] };
      for (const id of picked) {
        if (!target.cameras.some((c) => c.videoId === id)) target.cameras.push({ videoId: id, label: '', offset: offsets.get(id) ?? 0 });
      }
      const saved = await VR.saveRoom(VR.normalizeRoom(target));
      const allVerified = [...picked].every((id) => offsets.has(id));
      panel.remove();
      onDone(picked.size, saved.id, allVerified);
    });

    return panel;
  }

  function eventName(info, videoId) {
    if (!info) return `Событие ${videoId}`;
    return globalThis.VRAngleSearch.buildQueries(info)[0].slice(0, 100) || info.title;
  }

  // Compact bar under videos that aren't in any room yet.
  class FinderBar {
    constructor(videoId, { player, video, below }) {
      this.videoId = videoId;
      const find = h('button', { class: 'vr-btn vr-btn-accent', text: '🔍 Найти ракурсы' });
      const hide = h('button', { class: 'vr-btn', title: 'Скрыть (отключается в настройках расширения)', text: '✕' });
      this.el = h(
        'div',
        { class: 'vr-strip vr-finder' },
        h(
          'div',
          { class: 'vr-head' },
          h('span', { class: 'vr-title', text: '🎥 Videoroom' }),
          h('span', { class: 'vr-hint', text: 'Есть другие ракурсы этого события? Соберите их в комнату.' }),
          h('span', { class: 'vr-spacer' }),
          find,
          hide
        )
      );
      find.addEventListener('click', () => {
        if (this.panel) return;
        this.panel = searchPanel({
          videoId,
          room: null,
          player: { playerEl: player, video },
          onDone: (added, roomId, allVerified) => {
            this.panel = null;
            if (added && !allVerified) offerSyncForRoom = roomId; // the session appears via storage change
          },
        });
        this.el.append(this.panel);
      });
      hide.addEventListener('click', () => this.destroy());
      below.prepend(this.el);
    }

    destroy() {
      this.el.remove();
    }
  }

  // ---------- lifecycle ----------

  let finder = null;

  // Shared rooms published to the registry (fetched by the background worker).
  async function sharedRoomFor(videoId) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'sharedRoom', videoId });
      return res?.room ? VR.normalizeRoom(res.room) : null;
    } catch {
      return null;
    }
  }

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

    let shared = false;
    if (vid && !room) {
      room = await sharedRoomFor(vid);
      shared = !!room;
      if (seq !== refreshSeq) return;
      if (session && room && session.pageVideoId === vid && session.room.id === room.id) return;
    }

    session?.destroy();
    session = null;
    finder?.destroy();
    finder = null;
    if (!vid) return;

    const els = await waitForElements(seq);
    if (!els || seq !== refreshSeq) return;
    if (room) {
      session = new RoomSession(room, vid, els, { shared });
      if (offerSyncForRoom === room.id) {
        offerSyncForRoom = null;
        session.syncAfterUpdate = true;
        session.maybeOfferSync();
      }
    } else if ((await VR.loadSettings()).showFinder !== false && seq === refreshSeq) {
      finder = new FinderBar(vid, els);
    }
  }

  // Capture phase on window so we run before YouTube's own hotkeys.
  window.addEventListener('keydown', (e) => session?.onKey(e), true);
  document.addEventListener('yt-navigate-finish', refresh);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.rooms || changes.settings)) refresh();
  });
  refresh();
})();
