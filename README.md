# create-me

A photo booth web app for events (built for a townhall): attendees take a
webcam selfie, describe how they want to look (e.g. *"Make me a man with a
long beard, steampunk background"*), and get back an AI-edited version of
their photo — which they can download or print on the spot.

- **Image generation:** [Google Gemini 2.5 Flash Image ("Nano Banana")](https://ai.google.dev/) —
  cheap (~$0.039/image) image-to-image editing that preserves the person's
  likeness.
- **Runs on:** a single booth laptop, packaged as one Docker container. No
  cloud hosting, no AWS — the only outbound network call is to Google's
  Gemini API, so the laptop needs internet access.
- **Privacy:** nothing is stored. No database, no files written to disk, no
  logging of image bytes or prompts. Photos and results exist only in memory
  for the duration of a request / browser tab, and are cleared on "Start
  Over" or after 90 seconds of inactivity.

## Requirements

- Docker Desktop (or Docker Engine) installed on the booth laptop.
- Internet access at the venue (calls the Gemini API).
- A webcam and a browser that supports `getUserMedia` (Chrome/Edge recommended).
- A [Gemini API key](https://aistudio.google.com/app/apikey) from Google AI Studio.
- Optional: a connected printer for the "Print" button (uses your browser's
  normal print dialog — no special driver integration needed).

> **New to this project or setting up for the first time?** See
> [`SETUP.md`](./SETUP.md) for a detailed, step-by-step Windows installation
> walkthrough (installing Docker Desktop, getting an API key, kiosk mode, and
> troubleshooting).

## Running on the booth laptop

1. Get a Gemini API key from https://aistudio.google.com/app/apikey.
2. Build and run the container:

   ```powershell
   docker build -t create-me .
   docker run -p 3000:3000 -e GEMINI_API_KEY=YOUR_KEY_HERE create-me
   ```

   Or with docker-compose (reads `GEMINI_API_KEY` from your environment):

   ```powershell
   $env:GEMINI_API_KEY = "YOUR_KEY_HERE"
   docker compose up --build
   ```

3. Open a browser at `http://localhost:3000` on the booth laptop.
4. For kiosk mode, launch the browser fullscreen pointed at that URL, e.g.
   in Chrome: `chrome --kiosk http://localhost:3000`.
5. Grant camera permission when prompted (first launch only).

To reset between events, just stop and restart the container — there is no
persisted state to clean up.

## App flow

1. **Camera** — live webcam preview, "Take Photo" button captures a frame.
2. **Prompt** — shows the captured photo with a text box to describe the
   desired look; "Retake" goes back, "Generate" sends the photo + prompt to
   the backend.
3. **Loading** — backend calls the Gemini API server-side (API key never
   reaches the browser).
4. **Result** — shows the generated image with "Start Over", "Download",
   and "Print" (browser print dialog, styled to print only the image).
5. Auto-resets to the camera screen after 90 seconds of inactivity so the
   booth is always ready for the next attendee.

## Cost estimate

Gemini 2.5 Flash Image costs roughly **$0.039 per generated image**
(check [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) for
current rates). For an event with ~200 attendees generating one image each,
that's roughly **$8 total** — plus a small margin for retries.

## Guardrails & abuse protection

Since this may run unattended at a booth and could be resold as a product,
several layers of defense are built in (all server-side, so they can't be
bypassed by tampering with the browser):

- **Prompt validation** (`server/guardrails.js`): strips control characters,
  enforces a 500-character max, and rejects prompt-injection attempts (e.g.
  "ignore previous instructions", "reveal your system prompt", jailbreak
  phrasing) and a denylist of clearly disallowed content categories — all
  before any paid API call is made.
- **Image validation:** only `image/jpeg`, `image/png`, `image/webp` are
  accepted; base64 is checked for validity and capped at 10MB decoded.
- **Structural separation from the model:** the user's prompt is sent to
  Gemini as data alongside a fixed `system_instruction`, never concatenated
  into an instruction string, and explicit `safety_settings` are applied
  (blocking harassment/hate/sexual/dangerous content) as defense-in-depth on
  top of Gemini's own filters. Requests blocked by Gemini's safety system
  surface a friendly "try a different description" message.
- **Rate limiting:** `/api/generate` is capped per-IP (6/min) since it's the
  only endpoint that costs money and can be abused; a looser global limiter
  (120/min) guards against blunt traffic floods.
- **Security headers:** `helmet` sets a restrictive CSP, `X-Frame-Options`,
  `X-Content-Type-Options`, etc.
- **Client-side feedback:** the UI mirrors a subset of these checks (character
  counter, instant rejection message) purely for UX — the server always
  re-validates and is the sole source of truth.

None of this replaces human moderation for a large public deployment, but it
raises the bar significantly for casual abuse and keeps API costs bounded.

## Troubleshooting

- **Camera doesn't start:** check browser permissions (site settings ->
  Camera -> Allow) and make sure no other app is using the webcam.
- **"Server is not configured with GEMINI_API_KEY":** the container wasn't
  started with `-e GEMINI_API_KEY=...`; restart it with the key set.
- **429 / "busy" errors:** Gemini API rate limit hit; wait a few seconds and
  retry (the UI surfaces this as a friendly message).
- **Nothing prints:** the "Print" button opens your OS/browser's normal
  print dialog — make sure the target printer is installed and selected
  there, same as printing any web page.

## Project structure

```
server/
  index.js   - Express app: static file serving + /api/generate endpoint
  gemini.js  - Gemini 2.5 Flash Image REST API client
public/
  index.html - kiosk UI markup (camera / prompt / loading / result / error screens)
  style.css  - kiosk styling + print stylesheet
  app.js     - camera capture, API calls, download/print, idle-reset logic
server/
  guardrails.js - prompt/image validation and abuse-prevention rules
Dockerfile
docker-compose.yml
```
