document.addEventListener('DOMContentLoaded', async () => {
  const gallery = document.getElementById('gallery');
  const emptyMsg = document.getElementById('gallery-empty');
  const countEl = document.getElementById('gallery-count');
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightbox-img');
  const lightboxClose = document.getElementById('lightbox-close');

  // Any .jpg/.jpeg/.png/.webp/.gif/.avif dropped into /photos is picked up
  // automatically: serve.py scans the folder and writes photos/manifest.json.
  // Here we just fetch that list and build a masonry grid from it.
  async function loadPhotoList() {
    try {
      const res = await fetch('photos/manifest.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('manifest not found');
      const data = await res.json();
      return Array.isArray(data.files) ? data.files : [];
    } catch (err) {
      console.log('Could not load photos/manifest.json.', err);
      return [];
    }
  }

  function openLightbox(src, alt) {
    lightboxImg.src = src;
    lightboxImg.alt = alt;
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    lightbox.hidden = true;
    lightboxImg.src = '';
    document.body.style.overflow = '';
  }

  lightboxClose.addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) closeLightbox();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !lightbox.hidden) closeLightbox();
  });

  function addTile(filename) {
    const figure = document.createElement('figure');
    figure.className = 'tile';

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    img.src = `photos/${filename}`;

    img.addEventListener('click', () => openLightbox(img.src, img.alt));
    img.addEventListener('error', () => {
      figure.remove(); // skip files that fail to load rather than showing a broken tile
    });

    figure.appendChild(img);
    gallery.appendChild(figure);
  }

  const files = await loadPhotoList();

  if (!files.length) {
    emptyMsg.hidden = false;
    countEl.textContent = '';
    return;
  }

  emptyMsg.hidden = true;
  countEl.textContent = `${files.length} photo${files.length === 1 ? '' : 's'}`;
  files.forEach(addTile);
});
