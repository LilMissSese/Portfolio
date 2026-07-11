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
  const volumeEl = document.getElementById('music-volume');
  const volumeFill = document.getElementById('music-volume-fill');
  const volumeThumb = document.getElementById('music-volume-thumb');
  const titleEl = document.getElementById('music-title');
  const artEl = document.getElementById('music-art');
  const artFallbackEl = document.getElementById('music-art-fallback');

  if (!music) return;

  const STORAGE_KEY = 'sese-portfolio-music-state-v1';

  function readSavedState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function writeSavedState(patch) {
    try {
      const current = readSavedState() || {};
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...patch }));
    } catch (err) { /* localStorage unavailable (private mode etc) — just skip persistence */ }
  }

  const savedState = readSavedState();

  // ── Pick / load the track ──────────────────────────────────────
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

  if (toggle && volumeEl && volumeFill && volumeThumb) {
    const FADE_SECONDS = 1.8; // length of the in/out fade, in seconds of audio time
    const initialVolumePercent = savedState && typeof savedState.volume === 'number'
      ? Math.round(savedState.volume * 100)
      : 50;
    let userVolume = initialVolumePercent / 100; // 0–1, set by the slider
    let playing = false;

    // iOS ignores JS changes to audio.volume entirely — only the
    // hardware buttons control loudness there. To actually change
    // volume in code we have to route playback through the Web Audio
    // API and scale the signal with a GainNode instead. This works the
    // same way on every browser, so we use it everywhere rather than
    // branching per-platform. AudioContext also starts suspended until
    // a user gesture resumes it (another iOS requirement) — handled by
    // resumeAudioContext() below, called from every gesture handler we
    // already have (toggle click, first tap/keypress).
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioContextClass();
    const sourceNode = audioCtx.createMediaElementSource(music);
    const gainNode = audioCtx.createGain();
    sourceNode.connect(gainNode).connect(audioCtx.destination);
    gainNode.gain.value = 0;

    function resumeAudioContext() {
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch((err) => console.log('Could not resume audio context:', err));
      }
    }

    function setVolumeUI(percent) {
      const clamped = Math.max(0, Math.min(100, percent));
      volumeFill.style.height = clamped + '%';
      volumeThumb.style.bottom = clamped + '%';
      volumeEl.setAttribute('aria-valuenow', String(Math.round(clamped)));
      return clamped;
    }
    setVolumeUI(initialVolumePercent);
    volumeEl.setAttribute('aria-valuemin', '0');
    volumeEl.setAttribute('aria-valuemax', '100');

    function applyFade() {
      if (!music.duration || isNaN(music.duration)) {
        gainNode.gain.value = 0;
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

      const target = Math.max(0, Math.min(1, userVolume * fadeMultiplier));
      gainNode.gain.setTargetAtTime(target, audioCtx.currentTime, 0.05);
    }

    music.addEventListener('timeupdate', applyFade);

    function setVolume(percent) {
      const clamped = setVolumeUI(percent);
      userVolume = clamped / 100;
      applyFade();
      writeSavedState({ volume: userVolume });
    }

    // Custom vertical slider, driven by pointer events so it works the
    // same on mouse, touch, and pen regardless of any given browser's
    // native <input type=range> quirks.
    //
    // On mobile, measuring getBoundingClientRect() fresh on every
    // pointermove and computing an *absolute* position from it is
    // fragile: a vertical drag can trigger the browser's address bar /
    // toolbar to collapse mid-gesture, which shifts the viewport and
    // moves rect.bottom out from under your finger. That made the
    // slider seem to only ever creep upward and get stuck once the
    // chrome finished collapsing.
    //
    // Fix: measure the track height once at pointerdown, then track
    // the finger's *relative* movement (delta) from the starting
    // point instead of recomputing an absolute position on every
    // move. A mid-drag viewport shift no longer matters because we
    // never re-read the rect after the drag begins.
    volumeEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      resumeAudioContext();
      volumeEl.setPointerCapture(e.pointerId);

      const rect = volumeEl.getBoundingClientRect();
      const trackHeight = rect.height || 1;
      const startY = e.clientY;
      const startPercent = parseFloat(volumeEl.getAttribute('aria-valuenow')) || (userVolume * 100);

      // A direct tap still jumps straight to that position, using the
      // rect we just measured (safe here since it's pointerdown, before
      // any chrome collapse has a chance to happen).
      const tapPercent = ((rect.bottom - e.clientY) / trackHeight) * 100;
      setVolume(tapPercent);

      const onMove = (ev) => {
        const deltaY = startY - ev.clientY; // finger moving up (smaller Y) = positive = louder
        const deltaPercent = (deltaY / trackHeight) * 100;
        setVolume(startPercent + deltaPercent);
      };
      const onUp = (ev) => {
        volumeEl.releasePointerCapture(ev.pointerId);
        volumeEl.removeEventListener('pointermove', onMove);
        volumeEl.removeEventListener('pointerup', onUp);
        volumeEl.removeEventListener('pointercancel', onUp);
      };
      volumeEl.addEventListener('pointermove', onMove);
      volumeEl.addEventListener('pointerup', onUp);
      volumeEl.addEventListener('pointercancel', onUp);
    });

    volumeEl.addEventListener('keydown', (e) => {
      const current = parseFloat(volumeEl.getAttribute('aria-valuenow')) || 0;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
        setVolume(current + 5);
        e.preventDefault();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
        setVolume(current - 5);
        e.preventDefault();
      }
    });

    function setPlayingUI(isPlaying) {
      playing = isPlaying;
      toggle.classList.toggle('is-playing', isPlaying);
      toggle.setAttribute('aria-pressed', String(isPlaying));
      toggle.setAttribute('aria-label', isPlaying ? 'Pause music' : 'Play music');
      writeSavedState({ playing: isPlaying });
    }

    async function attemptAutoplay() {
      // Playback itself can always start "silently" here because gain
      // is 0 until applyFade raises it, and the AudioContext starts
      // suspended (no audible output at all) until a user gesture
      // resumes it — so we don't need the old muted-attribute trick.
      try {
        await music.play();
        setPlayingUI(true);
      } catch (err) {
        console.log('Autoplay blocked entirely; waiting for a click to start playback.', err);
        setPlayingUI(false);
      }

      const startOnInteraction = async () => {
        resumeAudioContext();
        if (!playing) {
          try {
            await music.play();
            setPlayingUI(true);
          } catch (e) { /* ignore */ }
        }
        window.removeEventListener('pointerdown', startOnInteraction);
        window.removeEventListener('keydown', startOnInteraction);
        window.removeEventListener('touchstart', startOnInteraction);
      };
      window.addEventListener('pointerdown', startOnInteraction, { once: true });
      window.addEventListener('keydown', startOnInteraction, { once: true });
      window.addEventListener('touchstart', startOnInteraction, { once: true });
    }

    toggle.addEventListener('click', async () => {
      const wasSuspended = audioCtx.state === 'suspended';
      resumeAudioContext();
      await trackReady;

      if (wasSuspended) {
        // This tap's real job was just to unlock audio for iOS. If the
        // music was already silently autoplaying (gain was 0), let it
        // keep playing — now audibly — instead of treating this tap as
        // a request to pause what looked, visually, like it was
        // already going.
        if (!playing) {
          try {
            await music.play();
            setPlayingUI(true);
          } catch (e) { /* ignore */ }
        }
        return;
      }

      if (playing) {
        music.pause();
        setPlayingUI(false);
      } else {
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
