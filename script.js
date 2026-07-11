// Background music now lives in music-player.js, shared across every
// page. This file just keeps the small index-page-only interactions.
document.addEventListener('DOMContentLoaded', () => {

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
