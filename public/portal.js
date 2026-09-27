'use strict';

/**
 * Printer-operator portal: gates on the same session code used by the main
 * kiosk (POST /api/validate-session), then lists photos attendees have
 * opted to Save for that session code (GET /api/photos) and links each
 * thumbnail to its raw image at /<uuid> for downloading/printing.
 *
 * The session code is kept in memory only for this tab's lifetime — never
 * written to localStorage/sessionStorage/cookies — matching the main app's
 * privacy posture.
 */
(function () {
  const screens = {
    sessionCode: document.getElementById('screen-session-code'),
    gallery: document.getElementById('screen-gallery'),
  };

  const sessionCodeInput = document.getElementById('session-code-input');
  const sessionCodeSubmit = document.getElementById('btn-session-code-submit');
  const sessionCodeError = document.getElementById('session-code-error');

  const refreshBtn = document.getElementById('btn-refresh');
  const galleryError = document.getElementById('gallery-error');
  const galleryEmpty = document.getElementById('gallery-empty');
  const galleryGrid = document.getElementById('gallery-grid');

  let currentSessionCode = null;

  function showScreen(name) {
    Object.values(screens).forEach((el) => el.classList.remove('active'));
    screens[name].classList.add('active');
  }

  async function submitSessionCode() {
    const code = sessionCodeInput.value.trim();
    if (!code) {
      sessionCodeError.textContent = 'Session code is required.';
      sessionCodeError.hidden = false;
      return;
    }
    sessionCodeError.hidden = true;

    try {
      const res = await fetch('/api/validate-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Code': code,
        },
        body: JSON.stringify({ sessionCode: code }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        sessionCodeError.textContent = data.error || 'Invalid or missing session code.';
        sessionCodeError.hidden = false;
        sessionCodeInput.value = '';
        return;
      }

      currentSessionCode = code;
      sessionCodeError.hidden = true;
      sessionCodeInput.value = '';
      showScreen('gallery');
      loadGallery();
    } catch {
      sessionCodeError.textContent = 'Could not verify session code. Please try again.';
      sessionCodeError.hidden = false;
      sessionCodeInput.value = '';
    }
  }

  async function loadGallery() {
    galleryError.hidden = true;
    galleryEmpty.hidden = true;
    galleryGrid.innerHTML = '';

    try {
      const res = await fetch('/api/photos', {
        headers: { 'X-Session-Code': currentSessionCode || '' },
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        galleryError.textContent = data.error || 'Could not load saved photos.';
        galleryError.hidden = false;
        return;
      }

      const photos = data.photos || [];
      if (photos.length === 0) {
        galleryEmpty.hidden = false;
        return;
      }

      for (const photo of photos) {
        const link = document.createElement('a');
        link.className = 'gallery-item';
        link.href = `/${photo.id}`;
        link.target = '_blank';
        link.rel = 'noopener';

        const img = document.createElement('img');
        img.src = `/${photo.id}`;
        img.alt = 'Saved photo';
        img.loading = 'lazy';

        const label = document.createElement('span');
        label.className = 'gallery-item-label';
        label.textContent = new Date(photo.createdAt).toLocaleTimeString();

        link.appendChild(img);
        link.appendChild(label);
        galleryGrid.appendChild(link);
      }
    } catch {
      galleryError.textContent = 'Could not load saved photos.';
      galleryError.hidden = false;
    }
  }

  sessionCodeSubmit.addEventListener('click', submitSessionCode);
  sessionCodeInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') submitSessionCode();
  });
  refreshBtn.addEventListener('click', loadGallery);
})();
