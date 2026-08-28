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

## Session Code (Access Control)

By default, the app runs without session code validation. To require a session
code before attendees can generate images, set the `SESSION_CODE` environment
variable:

```powershell
docker run -p 3000:3000 -e GEMINI_API_KEY=YOUR_KEY -e SESSION_CODE=myevent2k26 create-me
```

Or with docker-compose, add to your `.env`:
```
SESSION_CODE=myevent2k26
```

When a session code is configured:
- The app displays a login screen on first load
- Users must enter the session code to proceed
- The code is stored in the browser's session (cleared when browser is closed)
- All API calls are validated server-side

This is useful for:
- Preventing remote abuse (rate-limiting API costs)
- Multiple events using the same booth laptop
- Sharing a deployment among several teams

Default session code: `create-me-townhall-2k26`