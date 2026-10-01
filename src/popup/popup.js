(() => {
  'use strict';

  const VR = globalThis.VR;
  const $ = (s) => document.querySelector(s);

  let rooms = {};
  let currentVideoId = null;
  let editingId = null; // room id being edited, or null for a new room

  function h(tag, props, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of children) if (c != null && c !== false) e.append(c);
    return e;
  }

  function show(view) {
    for (const id of ['list-view', 'edit-view', 'import-view', 'settings-view']) $('#' + id).hidden = id !== view;
  }

  function camCountLabel(n) {
    const m10 = n % 10;
    const m100 = n % 100;
    const word = m10 === 1 && m100 !== 11 ? 'ракурс' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'ракурса' : 'ракурсов';
    return `${n} ${word}`;
  }

  // ---------- list ----------

  function renderList() {
    const cur = $('#current');
    cur.textContent = '';
    if (currentVideoId) {
      const room = VR.findRoomByVideo(rooms, currentVideoId);
      cur.append(
        room
          ? h('div', { class: 'row' },
              h('span', { text: `Это видео в комнате «${room.name}»` }),
              h('button', { class: 'link', text: 'Изменить', onclick: () => openEditor(room.id) }))
          : h('div', { class: 'row' },
              h('span', { text: 'Это видео не входит ни в одну комнату' }),
              h('button', { class: 'link', text: 'Создать комнату', onclick: () => openEditor(null, [currentVideoId]) }))
      );
    }

    const list = $('#rooms');
    list.textContent = '';
    const sorted = Object.values(rooms).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    for (const room of sorted) {
      const del = h('button', { class: 'danger', text: 'Удалить' });
      del.addEventListener('click', async () => {
        // Two-step confirm instead of window.confirm.
        if (del.dataset.armed) {
          await VR.deleteRoom(room.id);
          await reload();
        } else {
          del.dataset.armed = '1';
          del.textContent = 'Точно?';
          setTimeout(() => {
            delete del.dataset.armed;
            del.textContent = 'Удалить';
          }, 2500);
        }
      });
      const exp = h('button', { text: 'Экспорт', title: 'Скопировать JSON комнаты' });
      exp.addEventListener('click', async () => {
        const { name, audioMode, cameras, stage } = room;
        await navigator.clipboard.writeText(JSON.stringify({ name, audioMode, cameras, stage }, null, 2));
        exp.textContent = 'Скопировано';
        setTimeout(() => (exp.textContent = 'Экспорт'), 1500);
      });
      list.append(
        h('div', { class: 'room' },
          h('img', { src: VR.thumbUrl(room.cameras[0].videoId, 'default'), alt: '' }),
          h('div', { class: 'info' },
            h('div', { class: 'name', text: room.name }),
            h('div', { class: 'muted small', text: camCountLabel(room.cameras.length) })),
          h('div', { class: 'btns' },
            h('button', { text: '🎬', title: 'Открыть в кинозале', onclick: () => openCinema(room) }),
            h('button', { text: '🌐', title: 'Поделиться: опубликовать комнату для всех пользователей Videoroom', onclick: () => shareRoom(room) }),
            h('button', { text: 'Изменить', onclick: () => openEditor(room.id) }),
            exp,
            del))
      );
    }
  }

  async function openCinema(room) {
    const base = await VR.cinemaUrl();
    const start = Math.min(...room.cameras.map((c) => c.offset));
    await chrome.tabs.create({ url: base + VR.encodeRoomHash({ room, t: start }) });
    window.close();
  }

  // Publishing goes through a GitHub issue: the registry's Action validates
  // the JSON and adds the room (see registry/ in the extension's sources).
  async function shareRoom(room) {
    if (room.cameras.length < 2) return alert('В общей комнате должно быть хотя бы два ракурса.');
    const { id, name, audioMode, cameras, stage } = room;
    const json = JSON.stringify({ id, name, audioMode, cameras, stage }, null, 2);
    const body =
      'Комната Videoroom для общего доступа. Нажмите **Submit new issue**: бот проверит её и ответит здесь.\n\n' +
      '```json\n' + json + '\n```\n';
    const url =
      'https://github.com/Beetlejuice8921/videoroom-rooms/issues/new?' +
      new URLSearchParams({ title: `Room: ${name}`, body }).toString();
    await chrome.tabs.create({ url });
    window.close();
  }

  // ---------- settings ----------

  async function openSettings() {
    const settings = await VR.loadSettings();
    $('#cinema-url').value = settings.cinemaUrl || '';
    $('#show-finder').checked = settings.showFinder !== false;
    $('#use-shared').checked = settings.useShared !== false;
    $('#settings-error').hidden = true;
    show('settings-view');
  }

  async function saveSettingsForm() {
    const raw = $('#cinema-url').value.trim();
    const err = $('#settings-error');
    if (raw && !/^https:\/\/[^#]+\/room\.html$/i.test(raw)) {
      err.textContent = 'Нужен https-адрес, оканчивающийся на /room.html (без #)';
      err.hidden = false;
      return;
    }
    const settings = await VR.loadSettings();
    if (raw) settings.cinemaUrl = raw;
    else delete settings.cinemaUrl;
    settings.showFinder = $('#show-finder').checked;
    settings.useShared = $('#use-shared').checked;
    await VR.saveSettings(settings);
    show('list-view');
  }

  // ---------- editor ----------

  function addCamRow(cam = {}) {
    const img = h('img', { alt: '' });
    const url = h('input', { class: 'url', type: 'text', placeholder: 'Ссылка на YouTube или ID видео' });
    const label = h('input', { class: 'label', type: 'text', placeholder: 'Подпись (необязательно): «Слева у сцены»' });
    const offset = h('input', { class: 'offset', type: 'number', step: '0.1', value: '0', title: 'Сдвиг, секунды' });
    const remove = h('button', { class: 'remove', text: '×', title: 'Убрать' });
    const row = h('div', { class: 'cam-row' }, img, url, offset, remove, label);

    const updateThumb = () => {
      const id = VR.parseVideoId(url.value);
      url.classList.toggle('invalid', !!url.value.trim() && !id);
      if (id) img.src = VR.thumbUrl(id, 'default');
      else img.removeAttribute('src');
    };
    url.addEventListener('input', updateThumb);
    url.addEventListener('paste', (e) => {
      const text = e.clipboardData.getData('text');
      const lines = text.split(/\s*[\r\n]+\s*/).filter(Boolean);
      if (lines.length < 2) return;
      e.preventDefault();
      url.value = lines[0];
      updateThumb();
      let after = row;
      for (const line of lines.slice(1)) {
        const r = addCamRow({ videoId: line });
        after.after(r);
        after = r;
      }
    });
    remove.addEventListener('click', () => row.remove());

    url.value = cam.videoId || '';
    label.value = cam.label || '';
    offset.value = String(cam.offset ?? 0);
    updateThumb();
    $('#cam-rows').append(row);
    return row;
  }

  function openEditor(roomId, presetIds = []) {
    editingId = roomId;
    const room = roomId ? rooms[roomId] : null;
    $('#edit-title').textContent = room ? 'Изменить комнату' : 'Новая комната';
    $('#room-name').value = room ? room.name : '';
    $('#room-audio').value = room ? room.audioMode : 'main';
    $('#cam-rows').textContent = '';
    $('#edit-error').hidden = true;
    const cams = room ? room.cameras : presetIds.map((videoId) => ({ videoId }));
    for (const cam of cams) addCamRow(cam);
    if (cams.length < 2) addCamRow();
    if (cams.length < 1) addCamRow();
    show('edit-view');
    $('#room-name').focus();
  }

  function editError(msg) {
    const e = $('#edit-error');
    e.textContent = msg;
    e.hidden = !msg;
  }

  // Video ids of `room` that already belong to another room.
  function conflicts(room) {
    const out = [];
    for (const cam of room.cameras) {
      const other = VR.findRoomByVideo(rooms, cam.videoId);
      if (other && other.id !== room.id) out.push(`${cam.videoId} уже в комнате «${other.name}»`);
    }
    return out;
  }

  async function saveEditor() {
    const cameras = [];
    const seen = new Set();
    for (const row of document.querySelectorAll('.cam-row')) {
      const raw = row.querySelector('.url').value.trim();
      if (!raw) continue;
      const videoId = VR.parseVideoId(raw);
      if (!videoId) return editError(`Не удалось распознать ссылку: ${raw}`);
      if (seen.has(videoId)) return editError(`Видео ${videoId} добавлено дважды`);
      seen.add(videoId);
      cameras.push({
        videoId,
        label: row.querySelector('.label').value.trim(),
        offset: Number(row.querySelector('.offset').value) || 0,
      });
    }
    if (!cameras.length) return editError('Добавьте хотя бы одно видео');

    const room = VR.normalizeRoom({
      id: editingId || VR.newRoomId(),
      name: $('#room-name').value,
      audioMode: $('#room-audio').value,
      cameras,
    });
    const bad = conflicts(room);
    if (bad.length) return editError(bad.join('\n'));

    await VR.saveRoom(room);
    await reload();
  }

  // ---------- import ----------

  async function doImport() {
    const err = $('#import-error');
    err.hidden = true;
    let room;
    try {
      room = VR.normalizeRoom(JSON.parse($('#import-text').value));
    } catch {
      room = null;
    }
    if (!room) {
      err.textContent = 'Не похоже на комнату Videoroom (нужен JSON с полем cameras)';
      err.hidden = false;
      return;
    }
    room.id = VR.newRoomId();
    const bad = conflicts(room);
    if (bad.length) {
      err.textContent = bad.join('\n');
      err.hidden = false;
      return;
    }
    await VR.saveRoom(room);
    $('#import-text').value = '';
    await reload();
  }

  // ---------- init ----------

  async function reload() {
    rooms = await VR.loadRooms();
    renderList();
    show('list-view');
  }

  async function init() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      currentVideoId = tab?.url ? VR.parseVideoId(tab.url) : null;
    } catch {
      currentVideoId = null;
    }

    $('#new-room').addEventListener('click', () => openEditor(null, currentVideoId && !VR.findRoomByVideo(rooms, currentVideoId) ? [currentVideoId] : []));
    $('#open-import').addEventListener('click', () => {
      $('#import-error').hidden = true;
      show('import-view');
    });
    $('#add-cam').addEventListener('click', () => addCamRow().querySelector('.url').focus());
    $('#save-room').addEventListener('click', saveEditor);
    $('#cancel-room').addEventListener('click', () => show('list-view'));
    $('#edit-back').addEventListener('click', () => show('list-view'));
    $('#import-back').addEventListener('click', () => show('list-view'));
    $('#do-import').addEventListener('click', doImport);
    $('#open-settings').addEventListener('click', openSettings);
    $('#settings-back').addEventListener('click', () => show('list-view'));
    $('#save-settings').addEventListener('click', saveSettingsForm);

    await reload();
  }

  init();
})();
