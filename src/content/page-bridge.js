// Runs in the page's MAIN world: the isolated content script can't call the
// player's JS API (#movie_player.loadVideoById etc.), so it asks us via
// DOM events. dispatchEvent is synchronous, so the reply arrives before
// the request's dispatchEvent returns.
(() => {
  'use strict';

  document.addEventListener('videoroom:request', (e) => {
    let req;
    try {
      req = JSON.parse(e.detail);
    } catch {
      return;
    }
    const mp = document.getElementById('movie_player');
    let result = null;
    let error = null;
    try {
      if (!mp || typeof mp.getVideoData !== 'function') throw new Error('player not ready');
      switch (req.cmd) {
        case 'load':
          mp.loadVideoById({ videoId: req.args.videoId, startSeconds: req.args.start });
          break;
        case 'seek':
          mp.seekTo(req.args.t, true);
          break;
        case 'videoId':
          result = mp.getVideoData()?.video_id || null;
          break;
        case 'getVolume':
          result = { volume: mp.getVolume(), muted: mp.isMuted() };
          break;
        case 'setVolume':
          mp.setVolume(req.args.volume);
          if (req.args.muted) mp.mute();
          else mp.unMute();
          break;
        default:
          throw new Error('unknown command ' + req.cmd);
      }
    } catch (err) {
      error = String(err && err.message ? err.message : err);
    }
    document.dispatchEvent(
      new CustomEvent('videoroom:response', { detail: JSON.stringify({ id: req.id, result, error }) })
    );
  });
})();
