// ── Shared background music player ──────────────────────────────
// Included on every page that has the #bg-music / .music-control
// markup. Handles: picking a track, reading ID3 tags for title/art,
// fade in/out, the volume slider, and — the important part for
// multi-page sites like this one — remembering what was playing so
// clicking from index.html to gallery.html (or back) doesn't restart
// the song from zero.
//
// Honest limitation: this is a set of static HTML pages, not a
// single-page app, so a real full-page navigation always tears down
// and recreates the <audio> element. True gapless playback across
// pages isn't possible without turning the site into an SPA. What we
// do instead: save the current track + exact playback position +
// volume right before you leave, and on the next page, load the same
// track and immediately seek to that position before playing. There
// will still be a tiny (well under a second) gap while the new page's
// audio file loads, but the song picks up where it left off instead
// of restarting — same track, same spot, same volume.
document.addEventListener('DOMContentLoaded', () => {

  const music = document.getElementById('bg-music');
  const toggle = document.getElementById('music-toggle');
  const volumeSlider = document.getElementById('music-volume');
  const titleEl = document.getElementById('music-title');
  const artEl = document.getElementById('music-art');
  const artFallbackEl = document.getElementById('music-art-fallback');
  const musicControl = document.querySelector('.music-control');

  if (!music) return;

  const STORAGE_KEY = 'sese-portfolio-music-state-v1';

  function readSavedState() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function writeSavedState(patch) {
    try {
      const current = readSavedState() || {};
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...patch }));
    } catch (err) { /* sessionStorage unavailable (private mode etc) — just skip persistence */ }
  }

  const savedState = readSavedState();

  // ── Keep the widget pinned on mobile, regardless of what the ──────
  // browser's address bar / virtual keyboard / viewport is doing.
  // position:fixed *should* be enough, but several mobile browsers
  // shift fixed elements while the URL bar hides on scroll or the
  // page rubber-bands, which is what made this look like it was
  // "moving around and blocking things." Re-asserting the offset from
  // visualViewport on every change is a reliable backstop on top of
  // the CSS.
  if (musicControl && window.visualViewport) {
    const vv = window.visualViewport;
    const lockPosition = () => {
      const offsetX = window.innerWidth - vv.width - vv.offsetLeft;
      musicControl.style.transform = `translate(${-offsetX}px, ${-vv.offsetTop}px)`;
    };
    vv.addEventListener('resize', lockPosition);
    vv.addEventListener('scroll', lockPosition);
    lockPosition();
  }

  // Any .mp3/.m4a/.ogg/.wav/.flac/.aac dropped into /music is picked up
  // automatically: serve.py scans the folder and writes music/manifest.json,
  // and here we just read that list and choose a track from it. Falls back
  // to a single known file if the manifest is missing (e.g. opened without
  // the provided serve.py, via a plain static file server).
  async function pickTrack() {
    const fallback = 'music/warmth.mp3';
    try {
      const res = await fetch('music/manifest.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('manifest not found');
      const data = await res.json();
      const tracks = Array.isArray(data.tracks) ? data.tracks : [];
      if (!tracks.length) return fallback;
      const chosen = tracks[Math.floor(Math.random() * tracks.length)];
      return `music/${chosen}`;
    } catch (err) {
      console.log('Could not load music/manifest.json, falling back to a default track.', err);
      return fallback;
    }
  }

  // Read ID3v2 tags (title + album art) directly from the mp3's bytes.
  // Hand-rolled rather than relying on a third-party library, since
  // several popular JS ID3 readers mis-parse ID3v2.4's synchsafe
  // frame sizes and silently fail on files tagged with newer encoders.
  async function readID3Tags(url) {
    const res = await fetch(url);
    const buf = new Uint8Array(await res.arrayBuffer());

    if (String.fromCharCode(buf[0], buf[1], buf[2]) !== 'ID3') return null;

    const majorVersion = buf[3];
    const synchsafe = (a, b, c, d) => (a << 21) | (b << 14) | (c << 7) | d;
    const tagSize = synchsafe(buf[6], buf[7], buf[8], buf[9]);
    const hasExtHeader = (buf[5] & 0x40) !== 0;

    let pos = 10;
    if (hasExtHeader) {
      const extSize = majorVersion >= 4
        ? synchsafe(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3])
        : (buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
      pos += extSize;
    }

    const end = 10 + tagSize;
    const result = { title: null, artist: null, picture: null };

    function readFrameSize(p) {
      // ID3v2.4 frame sizes are synchsafe; v2.3 frame sizes are plain big-endian.
      return majorVersion >= 4
        ? synchsafe(buf[p], buf[p + 1], buf[p + 2], buf[p + 3])
        : (buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
    }

    function decodeText(bytes) {
      if (!bytes.length) return '';
      const enc = bytes[0];
      const body = bytes.slice(1);
      let text;
      if (enc === 1) text = new TextDecoder('utf-16').decode(body);
      else if (enc === 2) text = new TextDecoder('utf-16be').decode(body);
      else if (enc === 3) text = new TextDecoder('utf-8').decode(body);
      else text = new TextDecoder('latin1').decode(body);
      return text.replace(/\u0000+$/, '').trim();
    }

    while (pos < end - 10) {
      const id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
      if (id === '\u0000\u0000\u0000\u0000') break;
      const size = readFrameSize(pos + 4);
      const frameStart = pos + 10;
      const frame = buf.slice(frameStart, frameStart + size);
      if (!size) { pos = frameStart; continue; }

      if (id === 'TIT2') {
        result.title = decodeText(frame);
      } else if (id === 'TPE1') {
        result.artist = decodeText(frame);
      } else if (id === 'APIC' && !result.picture) {
        // encoding(1) + mime(str, null-terminated) + picture type(1) + description(str, null-terminated) + data
        const enc = frame[0];
        let i = 1;
        let mime = '';
        while (frame[i] !== 0 && i < frame.length) { mime += String.fromCharCode(frame[i]); i++; }
        i++; // skip null
        i++; // skip picture type byte
        if (enc === 1 || enc === 2) {
          while (i < frame.length - 1 && !(frame[i] === 0 && frame[i + 1] === 0)) i++;
          i += 2;
        } else {
          while (i < frame.length && frame[i] !== 0) i++;
          i += 1;
        }
        const imgBytes = frame.slice(i);
        result.picture = { mime: mime || 'image/jpeg', bytes: imgBytes };
      }

      pos = frameStart + size;
    }

    return result;
  }

  // If we have a saved track from a previous page, reuse it (same song,
  // don't reroll the random pick) — otherwise choose one as normal.
  async function resolveTrackSrc() {
    if (savedState && savedState.src) return savedState.src;
    return pickTrack();
  }

  // trackReady resolves once music.src has actually been assigned, so
  // playback (below) can wait for it instead of racing the async pick.
  const trackReady = resolveTrackSrc().then((src) => {
    music.src = src;
    return src;
  });

  trackReady.then((src) => readID3Tags(src)).then((tags) => {
    if (!tags) return;
    const name = tags.title || tags.artist;
    if (name && titleEl) titleEl.textContent = name;

    if (tags.picture && artEl && artFallbackEl) {
      const blob = new Blob([tags.picture.bytes], { type: tags.picture.mime });
      artEl.src = URL.createObjectURL(blob);
      artEl.hidden = false;
      artFallbackEl.hidden = true;
    }
  }).catch((err) => {
    console.log('Could not set up track / read ID3 tags:', err);
  });

  // Resume at the saved position once the browser knows the track's
  // duration, but only if it's the same track we saved (it always will
  // be, since resolveTrackSrc reuses the saved src, but this guards
  // against a stale/mismatched entry).
  const seekReady = trackReady.then((src) => new Promise((resolve) => {
    if (!savedState || savedState.src !== src || !(savedState.time > 0)) {
      resolve();
      return;
    }
    music.addEventListener('loadedmetadata', () => {
      if (isFinite(savedState.time) && savedState.time < music.duration) {
        music.currentTime = savedState.time;
      }
      resolve();
    }, { once: true });
  }));

  if (toggle && volumeSlider) {
    const FADE_SECONDS = 1.8; // length of the in/out fade, in seconds of audio time
    const initialVolumePercent = savedState && typeof savedState.volume === 'number'
      ? Math.round(savedState.volume * 100)
      : (parseInt(volumeSlider.value, 10) || 25);
    volumeSlider.value = String(initialVolumePercent);
    let userVolume = initialVolumePercent / 100; // 0–1, set by the slider
    let playing = false;

    music.volume = 0;

    function applyFade() {
      if (!music.duration || isNaN(music.duration)) {
        music.volume = 0;
        return;
      }
      const t = music.currentTime;
      const remaining = music.duration - t;
      let fadeMultiplier = 1;

      if (t < FADE_SECONDS) {
        fadeMultiplier = t / FADE_SECONDS;
      } else if (remaining < FADE_SECONDS) {
        fadeMultiplier = remaining / FADE_SECONDS;
      }

      music.volume = Math.max(0, Math.min(1, userVolume * fadeMultiplier));
    }

    music.addEventListener('timeupdate', applyFade);

    volumeSlider.addEventListener('input', () => {
      userVolume = (parseInt(volumeSlider.value, 10) || 0) / 100;
      applyFade();
      writeSavedState({ volume: userVolume });
    });

    function setPlayingUI(isPlaying) {
      playing = isPlaying;
      toggle.classList.toggle('is-playing', isPlaying);
      toggle.setAttribute('aria-pressed', String(isPlaying));
      toggle.setAttribute('aria-label', isPlaying ? 'Pause music' : 'Play music');
      writeSavedState({ playing: isPlaying });
    }

    async function attemptAutoplay() {
      // First, try to autoplay with sound on directly — some browsers
      // (and PWAs / installed sites, or pages you just navigated to
      // via a click, which counts as recent user activation) allow this.
      try {
        await music.play();
        setPlayingUI(true);
        return;
      } catch (err) {
        // Blocked. Fall back to the muted-autoplay trick, which almost
        // every browser allows, then unmute on the first interaction.
      }

      music.muted = true;
      try {
        await music.play();
        setPlayingUI(true);
        const unmute = () => {
          music.muted = false;
          window.removeEventListener('pointerdown', unmute);
          window.removeEventListener('keydown', unmute);
          window.removeEventListener('touchstart', unmute);
        };
        window.addEventListener('pointerdown', unmute, { once: true });
        window.addEventListener('keydown', unmute, { once: true });
        window.addEventListener('touchstart', unmute, { once: true });
      } catch (err) {
        console.log('Autoplay blocked entirely; waiting for a click to start playback.', err);
        setPlayingUI(false);
        const startOnInteraction = async () => {
          music.muted = false;
          try {
            await music.play();
            setPlayingUI(true);
          } catch (e) { /* ignore */ }
          window.removeEventListener('pointerdown', startOnInteraction);
          window.removeEventListener('keydown', startOnInteraction);
        };
        window.addEventListener('pointerdown', startOnInteraction, { once: true });
        window.addEventListener('keydown', startOnInteraction, { once: true });
      }
    }

    toggle.addEventListener('click', async () => {
      await trackReady;
      if (playing) {
        music.pause();
        setPlayingUI(false);
      } else {
        music.muted = false;
        try {
          await music.play();
          setPlayingUI(true);
        } catch (e) { /* ignore */ }
      }
    });

    // If we're resuming from a saved state, only autoplay if the user
    // hadn't paused it on the previous page. First-time visits (no
    // saved state) always try to autoplay, same as before.
    Promise.all([trackReady, seekReady]).then(() => {
      const shouldAutoplay = !savedState || savedState.playing !== false;
      if (shouldAutoplay) attemptAutoplay();
      else setPlayingUI(false);
    });

    // Persist the current track + position continuously (throttled to
    // ~1/sec via timeupdate's natural firing rate) and right before the
    // page is torn down, so the next page can resume accurately.
    trackReady.then((src) => {
      music.addEventListener('timeupdate', () => {
        writeSavedState({ src, time: music.currentTime });
      });
    });

    const persistNow = () => {
      writeSavedState({ time: music.currentTime, playing });
    };
    window.addEventListener('pagehide', persistNow);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') persistNow();
    });
  }
});
