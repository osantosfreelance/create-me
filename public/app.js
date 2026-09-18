'use strict';

/**
 * create-me kiosk frontend.
 * All state (captured photo, prompt, result) lives only in memory (JS variables / DOM),
 * never written to localStorage/sessionStorage/cookies, and is cleared on "Start Over"
 * or after an idle timeout so nothing lingers for the next attendee.
 */

(() => {
  const screens = {
    sessionCode: document.getElementById('screen-session-code'),
    camera: document.getElementById('screen-camera'),
    prompt: document.getElementById('screen-prompt'),
    loading: document.getElementById('screen-loading'),
    result: document.getElementById('screen-result'),
    error: document.getElementById('screen-error'),
  };

  const sessionCodeInput = document.getElementById('session-code-input');
  const btnSessionCodeSubmit = document.getElementById('btn-session-code-submit');
  const sessionCodeError = document.getElementById('session-code-error');

  let currentSessionCode = null;
  let sessionAssetIndex = null;

  const video = document.getElementById('video');
  const cameraError = document.getElementById('camera-error');
  const btnTakePhoto = document.getElementById('btn-take-photo');

  const capturedPhoto = document.getElementById('captured-photo');
  const promptInput = document.getElementById('prompt-input');
  const promptError = document.getElementById('prompt-error');
  const promptCount = document.getElementById('prompt-count');
  const promptHint = document.getElementById('prompt-hint');
  const btnRetake = document.getElementById('btn-retake');
  const btnGenerate = document.getElementById('btn-generate');
  const btnMic = document.getElementById('btn-mic');

  const resultPhoto = document.getElementById('result-photo');
  const printPhoto = document.getElementById('print-photo');
  const btnStartOver = document.getElementById('btn-start-over');
  const btnDownload = document.getElementById('btn-download');
  const btnPrint = document.getElementById('btn-print');

  const fatalErrorText = document.getElementById('fatal-error-text');
  const btnErrorRetry = document.getElementById('btn-error-retry');

  let mediaStream = null;
  // In-memory only — never persisted to disk/localStorage.
  let capturedImageDataUrl = null;
  let resultImageDataUrl = null;
  let composedResultImageDataUrl = null;
  let generationInFlight = false;

  // Speech-to-text
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let isListening = false;

  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    recognition.addEventListener('result', (e) => {
      let interim = '';
      let final = '';
      for (const result of e.results) {
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }
      const base = promptInput.dataset.speechBase || '';
      promptInput.value = base + (final || interim);
      if (final) promptInput.dataset.speechBase = base + final;
      updatePromptCount();
    });

    recognition.addEventListener('end', () => {
      isListening = false;
      btnMic.classList.remove('btn-mic--recording');
      btnMic.setAttribute('aria-label', 'Speak your prompt');
      delete promptInput.dataset.speechBase;
    });

    recognition.addEventListener('error', () => {
      isListening = false;
      btnMic.classList.remove('btn-mic--recording');
      delete promptInput.dataset.speechBase;
    });

    btnMic.hidden = false;

    btnMic.addEventListener('click', () => {
      if (isListening) {
        recognition.stop();
      } else {
        promptInput.dataset.speechBase = promptInput.value;
        recognition.start();
        isListening = true;
        btnMic.classList.add('btn-mic--recording');
        btnMic.setAttribute('aria-label', 'Stop recording');
      }
    });
  }

  const IDLE_TIMEOUT_MS = 90 * 1000; // reset to camera after 90s of inactivity
  let idleTimer = null;

  const MAX_PROMPT_LENGTH = 500;

  // Mirrors (a subset of) the server-side checks in server/guardrails.js, purely
  // for instant UX feedback. The server always re-validates and is the source
  // of truth — this client-side copy must never be relied on for security.
  const INJECTION_PATTERNS = [
    /ignore (all |the |any )?(previous|prior|above|earlier) instructions?/i,
    /disregard (all |the |any )?(previous|prior|above|earlier)/i,
    /system\s*(prompt|instruction|message)/i,
    /jailbreak/i,
    /\bapi[\s_-]?key\b/i,
    /<\s*script[\s>]/i,
  ];

  function clientValidatePrompt(text) {
    const trimmed = text.trim();
    // Prompt is optional: blank means "use the captured photo as-is".
    if (!trimmed) return null;
    if (trimmed.length > MAX_PROMPT_LENGTH) return `Prompt too long (max ${MAX_PROMPT_LENGTH} characters).`;
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(trimmed)) {
        return 'Please only describe how you want your photo to look (no instructions to the system).';
      }
    }
    return null;
  }

  function updatePromptCount() {
    const len = promptInput.value.length;
    promptCount.textContent = String(len);
    promptHint.classList.toggle('over-limit', len > MAX_PROMPT_LENGTH);
  }
  promptInput.addEventListener('input', updatePromptCount);

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

    // Validate the session code before allowing access to camera
    btnSessionCodeSubmit.disabled = true;
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

      const data = await res.json();

      if (!res.ok) {
        sessionCodeError.textContent = data.error || 'Invalid or missing session code.';
        sessionCodeError.hidden = false;
        sessionCodeInput.value = '';
        btnSessionCodeSubmit.disabled = false;
        return;
      }

      // Valid session code — proceed to camera
      currentSessionCode = code;
      document.getElementById('app').setAttribute('data-session-code', code);
      applySessionAssets(data.assetIndex);
      sessionCodeError.hidden = true;
      sessionCodeInput.value = '';
      showScreen('camera');
    } catch (err) {
      sessionCodeError.textContent = 'Could not verify session code. Please try again.';
      sessionCodeError.hidden = false;
      sessionCodeInput.value = '';
      btnSessionCodeSubmit.disabled = false;
    }
  }

  sessionCodeInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') submitSessionCode();
  });
  btnSessionCodeSubmit.addEventListener('click', submitSessionCode);

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // Only auto-reset if we're not sitting on the plain camera screen already.
      if (!screens.camera.classList.contains('active')) {
        startOver();
      }
    }, IDLE_TIMEOUT_MS);
  }

  ['click', 'keydown', 'touchstart'].forEach((evt) =>
    document.addEventListener(evt, resetIdleTimer, { passive: true })
  );

  async function startCamera() {
    cameraError.hidden = true;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      video.srcObject = mediaStream;
    } catch (err) {
      cameraError.textContent =
        'Could not access the camera. Please check permissions and reload the page.';
      cameraError.hidden = false;
    }
  }

  function stopCamera() {
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
  }

  function takePhoto() {
    const canvas = document.createElement('canvas');
    const videoWidth = video.videoWidth || 1280;
    const videoHeight = video.videoHeight || 960;
    const cropSize = Math.min(videoWidth, videoHeight);
    const cropX = Math.round((videoWidth - cropSize) / 2);
    const cropY = Math.round((videoHeight - cropSize) / 2);
    canvas.width = cropSize;
    canvas.height = cropSize;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, cropX, cropY, cropSize, cropSize, 0, 0, cropSize, cropSize);
    capturedImageDataUrl = canvas.toDataURL('image/jpeg', 0.92);
    capturedPhoto.src = capturedImageDataUrl;
    promptInput.value = '';
    updatePromptCount();
    promptError.hidden = true;
    showScreen('prompt');
  }

  function dataUrlToParts(dataUrl) {
    const [header, base64] = dataUrl.split(',');
    const mimeMatch = header.match(/data:(.*);base64/);
    return { mimeType: mimeMatch ? mimeMatch[1] : 'image/jpeg', base64 };
  }

  function makeClientRequestId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function setGenerateBusy(isBusy) {
    generationInFlight = isBusy;
    btnGenerate.disabled = isBusy;
    btnGenerate.setAttribute('aria-busy', isBusy ? 'true' : 'false');
  }

  async function generate() {
    if (generationInFlight) return;

    if (!currentSessionCode) {
      promptError.textContent = 'Session code is required. Please go back and enter it.';
      promptError.hidden = false;
      return;
    }

    const prompt = promptInput.value.trim();

    // If no prompt is provided, skip the paid AI call and proceed directly.
    if (!prompt) {
      promptError.hidden = true;
      resultImageDataUrl = capturedImageDataUrl;
      composedResultImageDataUrl = null;
      resultPhoto.src = resultImageDataUrl;
      showScreen('result');
      prewarmComposedResultImage();
      return;
    }

    const clientError = clientValidatePrompt(prompt);
    if (clientError) {
      promptError.textContent = clientError;
      promptError.hidden = false;
      return;
    }

    setGenerateBusy(true);
    promptError.hidden = true;
    showScreen('loading');

    const { mimeType, base64 } = dataUrlToParts(capturedImageDataUrl);
    const clientRequestId = makeClientRequestId();

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Request-Id': clientRequestId,
          'X-Session-Code': currentSessionCode || '',
        },
        body: JSON.stringify({ imageBase64: base64, mimeType, prompt, sessionCode: currentSessionCode }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Image generation failed.');
      }

      resultImageDataUrl = `data:${data.mimeType};base64,${data.imageBase64}`;
      composedResultImageDataUrl = null;
      resultPhoto.src = resultImageDataUrl;
      showScreen('result');
      prewarmComposedResultImage();
    } catch (err) {
      fatalErrorText.textContent = err.message || 'Something went wrong. Please try again.';
      showScreen('error');
    } finally {
      setGenerateBusy(false);
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
      img.src = src;
    });
  }

  // Branding assets are per-session: each session code maps to an asset index and the
  // matching `/<index>-photo-frame.png` / `/<index>-watermark.png` files. Sessions
  // without artwork yet simply render (and export) without frame/watermark.
  let watermarkImagePromise = Promise.resolve(null);
  let photoFrameImagePromise = Promise.resolve(null);

  function sessionAssetUrl(name) {
    return sessionAssetIndex ? `/${sessionAssetIndex}-${name}.png` : null;
  }

  function applySessionAssets(assetIndex) {
    const index = Number.parseInt(assetIndex, 10);
    sessionAssetIndex = Number.isInteger(index) && index > 0 ? index : null;

    document.querySelectorAll('[data-session-asset]').forEach((img) => {
      const url = sessionAssetUrl(img.dataset.sessionAsset);
      img.hidden = true;
      if (!url) {
        img.removeAttribute('src');
        return;
      }
      img.onload = () => {
        img.hidden = false;
      };
      img.onerror = () => {
        img.hidden = true;
      };
      img.src = url;
    });

    const frameUrl = sessionAssetUrl('photo-frame');
    const watermarkUrl = sessionAssetUrl('watermark');
    photoFrameImagePromise = frameUrl
      ? loadImage(frameUrl).catch((err) => {
          console.warn('Photo frame could not be preloaded; exported images will skip it.', err);
          return null;
        })
      : Promise.resolve(null);
    watermarkImagePromise = watermarkUrl
      ? loadImage(watermarkUrl).catch((err) => {
          console.warn('Watermark could not be preloaded; exported images will skip it.', err);
          return null;
        })
      : Promise.resolve(null);
  }

  function getWatermarkScale(canvas) {
    return Math.min(canvas.width, canvas.height) * 0.18;
  }

  function getWatermarkPadding(canvas) {
    return Math.min(canvas.width, canvas.height) * 0.02;
  }

  // Zoom the subject out within the frame so it doesn't run edge-to-edge and
  // get cut off/overlapped by the photo-frame's decorative border — most
  // noticeable on full-body shots. The frame's transparent window sits lower
  // than vertical-center, so the subject is shifted down (extra margin-top)
  // rather than centered symmetrically. Keep these two values in sync with
  // the `width/height` and `margin-top` applied to
  // video/#captured-photo/#result-photo in style.css.
  const PHOTO_ZOOM_SCALE = 0.75;
  const PHOTO_ZOOM_MARGIN_TOP = 0.06;

  async function composeFinalImage(dataUrl) {
    if (!dataUrl) return null;
    const baseImg = await loadImage(dataUrl);
    const [frame, wm] = await Promise.all([photoFrameImagePromise, watermarkImagePromise]);
    const baseWidth = baseImg.naturalWidth || baseImg.width;
    const baseHeight = baseImg.naturalHeight || baseImg.height;
    const cropSize = Math.min(baseWidth, baseHeight);
    const cropX = Math.round((baseWidth - cropSize) / 2);
    const cropY = Math.round((baseHeight - cropSize) / 2);

    const canvas = document.createElement('canvas');
    canvas.width = cropSize;
    canvas.height = cropSize;
    const ctx = canvas.getContext('2d');

    // Match the on-screen white background that shows through the margin left
    // by the zoomed-out subject.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const drawSize = Math.round(cropSize * PHOTO_ZOOM_SCALE);
    const drawOffsetX = Math.round((cropSize - drawSize) / 2);
    const drawOffsetY = Math.round((cropSize - drawSize) / 2 + cropSize * PHOTO_ZOOM_MARGIN_TOP);
    ctx.drawImage(baseImg, cropX, cropY, cropSize, cropSize, drawOffsetX, drawOffsetY, drawSize, drawSize);

    if (frame) {
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
    }
    if (wm) {
      const wmW = Math.round(getWatermarkScale(canvas));
      const wmH = Math.round(wmW * (wm.naturalHeight / wm.naturalWidth));
      const pad = Math.round(getWatermarkPadding(canvas));
      ctx.drawImage(wm, canvas.width - wmW - pad, canvas.height - wmH - pad, wmW, wmH);
    }

    return canvas.toDataURL('image/png');
  }

  async function getComposedResultImage() {
    if (!composedResultImageDataUrl && resultImageDataUrl) {
      composedResultImageDataUrl = await composeFinalImage(resultImageDataUrl);
    }
    return composedResultImageDataUrl;
  }

  // Kick off the (cheap) canvas compose as soon as we have a result, without
  // waiting for it. iOS Safari only lets window.print()/navigator.share() run
  // when they're triggered synchronously from the tap that invoked them, so by
  // the time the user taps Print/Download the composed image is normally
  // already cached and the click handlers below can act immediately.
  function prewarmComposedResultImage() {
    getComposedResultImage().catch((err) => {
      console.warn('Failed to prewarm composed result image.', err);
    });
  }

  function decodeImage(img) {
    // HTMLImageElement.prototype.decode isn't available in every browser;
    // fall back to the load event so this still works everywhere.
    if (typeof img.decode === 'function') return img.decode();
    if (img.complete) return Promise.resolve();
    return new Promise((resolve, reject) => {
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => reject(new Error('Failed to load image.')), { once: true });
    });
  }

  function isIos() {
    return /iP(hone|od|ad)/.test(navigator.userAgent) ||
      // iPadOS 13+ reports as "MacIntel" but exposes touch support.
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function dataUrlToBlob(dataUrl) {
    const { mimeType, base64 } = dataUrlToParts(dataUrl);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
  }

  function triggerAnchorDownload(dataUrl) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `create-me-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function downloadResult() {
    if (!resultImageDataUrl) return;
    const composed = (await getComposedResultImage()) || resultImageDataUrl;

    // iOS Safari doesn't support forced downloads of data: URLs via the
    // `download` attribute — it just opens the image instead of saving it.
    // Prefer the Web Share API (native "Save Image" via the share sheet) when
    // available, and fall back to opening the image in a new tab so the user
    // can long-press -> Save Image.
    if (navigator.canShare && typeof navigator.share === 'function') {
      try {
        const filename = `create-me-${Date.now()}.png`;
        const file = new File([dataUrlToBlob(composed)], filename, { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file] });
          return;
        }
      } catch (err) {
        // AbortError means the user cancelled the share sheet — not an error.
        if (err && err.name === 'AbortError') return;
        console.warn('navigator.share failed, falling back.', err);
      }
    }

    if (isIos()) {
      // No reliable forced-download path on iOS Safari without Web Share;
      // open the image so the user can long-press -> Save Image.
      window.open(composed, '_blank');
      return;
    }

    triggerAnchorDownload(composed);
  }

  async function printResult() {
    if (!resultImageDataUrl) return;

    // Fast path: composed image already prewarmed, so we can call
    // window.print() synchronously within the click's user gesture — required
    // for iOS Safari to actually open the print sheet.
    if (composedResultImageDataUrl) {
      printPhoto.src = composedResultImageDataUrl;
      window.print();
      return;
    }

    // Slow path (composed image wasn't ready yet): may not trigger the print
    // dialog on iOS since the gesture chain is broken by the awaits, but this
    // should be rare since compose is prewarmed as soon as the result is shown.
    const composed = await getComposedResultImage();
    if (!composed) return;
    printPhoto.src = composed;
    await decodeImage(printPhoto);
    window.print();
  }

  function startOver() {
    // Clear in-memory state so nothing lingers for the next attendee.
    capturedImageDataUrl = null;
    resultImageDataUrl = null;
    composedResultImageDataUrl = null;
    setGenerateBusy(false);
    capturedPhoto.src = '';
    resultPhoto.src = '';
    printPhoto.src = '';
    promptInput.value = '';
    delete promptInput.dataset.speechBase;
    if (recognition && isListening) {
      recognition.stop();
    }
    updatePromptCount();
    showScreen('camera');
    if (!mediaStream) startCamera();
  }

  btnTakePhoto.addEventListener('click', takePhoto);
  btnRetake.addEventListener('click', () => showScreen('camera'));
  btnGenerate.addEventListener('click', generate);
  btnStartOver.addEventListener('click', startOver);
  btnDownload.addEventListener('click', downloadResult);
  btnPrint.addEventListener('click', printResult);
  btnErrorRetry.addEventListener('click', startOver);

  window.addEventListener('beforeunload', stopCamera);

  // Init
  resetIdleTimer();
  startCamera();
})();
