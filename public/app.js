'use strict';

/**
 * create-me kiosk frontend.
 * All state (captured photo, prompt, result) lives only in memory (JS variables / DOM),
 * never written to localStorage/sessionStorage/cookies, and is cleared on "Start Over"
 * or after an idle timeout so nothing lingers for the next attendee.
 */

(() => {
  const screens = {
    camera: document.getElementById('screen-camera'),
    prompt: document.getElementById('screen-prompt'),
    loading: document.getElementById('screen-loading'),
    result: document.getElementById('screen-result'),
    error: document.getElementById('screen-error'),
  };

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
  const btnStartOver = document.getElementById('btn-start-over');
  const btnDownload = document.getElementById('btn-download');
  const btnPrint = document.getElementById('btn-print');

  const fatalErrorText = document.getElementById('fatal-error-text');
  const btnErrorRetry = document.getElementById('btn-error-retry');

  let mediaStream = null;
  // In-memory only — never persisted to disk/localStorage.
  let capturedImageDataUrl = null;
  let resultImageDataUrl = null;
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
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 960;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
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

    const prompt = promptInput.value.trim();

    // If no prompt is provided, skip the paid AI call and proceed directly.
    if (!prompt) {
      promptError.hidden = true;
      resultImageDataUrl = capturedImageDataUrl;
      resultPhoto.src = resultImageDataUrl;
      showScreen('result');
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
        },
        body: JSON.stringify({ imageBase64: base64, mimeType, prompt }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Image generation failed.');
      }

      resultImageDataUrl = `data:${data.mimeType};base64,${data.imageBase64}`;
      resultPhoto.src = resultImageDataUrl;
      showScreen('result');
    } catch (err) {
      fatalErrorText.textContent = err.message || 'Something went wrong. Please try again.';
      showScreen('error');
    } finally {
      setGenerateBusy(false);
    }
  }

  function downloadResult() {
    if (!resultImageDataUrl) return;
    const a = document.createElement('a');
    a.href = resultImageDataUrl;
    a.download = `create-me-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function printResult() {
    window.print();
  }

  function startOver() {
    // Clear in-memory state so nothing lingers for the next attendee.
    capturedImageDataUrl = null;
    resultImageDataUrl = null;
    setGenerateBusy(false);
    capturedPhoto.src = '';
    resultPhoto.src = '';
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
