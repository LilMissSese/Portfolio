document.addEventListener('DOMContentLoaded', () => {

  // ── Background music: autoplay, seamless fade loop, volume slider ──
  const music = document.getElementById('bg-music');
  const toggle = document.getElementById('music-toggle');
  const volumeSlider = document.getElementById('music-volume');
  const titleEl = document.getElementById('music-title');
  const artEl = document.getElementById('music-art');
  const artFallbackEl = document.getElementById('music-art-fallback');

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
        const descTerminatorLen = (enc === 1 || enc === 2) ? 2 : 1;
        // skip description (find null terminator, width depends on encoding)
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

  // trackReady resolves once music.src has actually been assigned, so
  // playback (below) can wait for it instead of racing the async pick.
  let trackReady = Promise.resolve();

  if (music) {
    trackReady = pickTrack().then((src) => {
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
  }

  if (music && toggle && volumeSlider) {
    const FADE_SECONDS = 1.8; // length of the in/out fade, in seconds of audio time
    let userVolume = (parseInt(volumeSlider.value, 10) || 25) / 100; // 0–1, set by the slider
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
    });

    function setPlayingUI(isPlaying) {
      playing = isPlaying;
      toggle.classList.toggle('is-playing', isPlaying);
      toggle.setAttribute('aria-pressed', String(isPlaying));
      toggle.setAttribute('aria-label', isPlaying ? 'Pause music' : 'Play music');
    }

    async function attemptAutoplay() {
      // First, try to autoplay with sound on directly — some browsers
      // (and PWAs / installed sites) allow this.
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

    trackReady.then(() => attemptAutoplay());
  }

  const links = document.querySelectorAll('.link-btn');

  links.forEach(link => {
    link.addEventListener('click', () => {
      const label = link.dataset.label || link.textContent.trim();
      console.log(`Link clicked: ${label}`);

      // simple visual feedback pulse (navigation is allowed to proceed)
      link.style.transition = 'transform .12s ease';
      link.style.transform = 'scale(0.97)';
      setTimeout(() => {
        link.style.transform = '';
      }, 120);
    });
  });

  const socialBtns = document.querySelectorAll('.social-btn');
  socialBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      console.log(`Social clicked: ${btn.getAttribute('aria-label')}`);
    });
  });
});