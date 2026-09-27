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
- **Privacy:** by default nothing is stored — no database, no files written
  to disk, no logging of image bytes or prompts. Photos and results exist
  only in memory for the duration of a request / browser tab, and are
  cleared on "Start Over" or after 90 seconds of inactivity. The one
  exception is the opt-in **Save** button (see below), which keeps a small,
  fixed number of photos in server memory so they can be downloaded/printed
  later via a QR code.

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
persisted state to clean up (saved photos, if any, live only in memory and
are gone the moment the container restarts).

## Saving Photos & the Operator Portal

On the result screen, attendees can tap **Save** to keep a copy on the
server and get a QR code (and link) they can scan to download it later —
handy if they want it on their phone instead of just printing it.

- Saved photos live **only in server memory** — nothing is written to disk
  or to a cloud bucket. The server keeps a fixed-size buffer of at most
  **5 saved photos at a time**, shared across the whole running instance.
  Once a 6th photo is saved, the oldest one is silently overwritten and its
  QR code/link stops working (404).
- There is no expiry timer — the only "cleanup" is that 5-photo rollover,
  and restarting/redeploying the container clears everything.
- Tell attendees to download promptly if they want to keep their saved
  photo, since it can be bumped by later saves from other attendees.
- Operators can view currently-saved photos (for their session code) at
  `/portal.html` — it's gated behind the same session code used at the
  kiosk, and links each thumbnail to its full-size image for downloading
  or printing.

This design is intentionally simple for a single small event on one
instance: if you run multiple autoscaled instances (e.g. Cloud Run with
`min-instances` > 1), each instance has its own independent 5-photo buffer,
so the portal on one instance won't show photos saved via another. For a
single booth laptop or a single Cloud Run instance this isn't an issue.

## Session Codes (Access Control & Branding)

The app ships with three session codes, each mapped to its own branding assets:

| Session code | Assets |
| --- | --- |
| `townhall-2k26` | `public/1-photo-frame.png`, `public/1-watermark.png` |
| `tech-fest-2k26` | `public/2-photo-frame.png`, `public/2-watermark.png` |
| `ai-experience-2k26` | `public/3-photo-frame.png`, `public/3-watermark.png` |

After a code is accepted, the browser loads `/<index>-photo-frame.png` and
`/<index>-watermark.png`. **If a file doesn't exist, it is simply skipped** — on
screen and in downloaded/printed images. Drop the artwork into `public/` with the
matching filename to enable it; no code change is needed.

To override the codes, set `SESSION_CODES` to a comma-separated list of
`code:index` pairs (the index is optional and defaults to the entry's position):

```powershell
docker run -p 3000:3000 -e GEMINI_API_KEY=YOUR_KEY -e SESSION_CODES=myevent2k26:1 create-me
```

Or with docker-compose, add to your `.env`:
```
SESSION_CODES=myevent2k26:1,otherevent2k26:2
```

Entries may also be separated with `|` instead of `,` (useful for tools like
`gcloud --set-env-vars`, which treat commas as their own delimiter).

The legacy single-code `SESSION_CODE` variable is still honoured when
`SESSION_CODES` is not set.

Session code behaviour:
- The app displays a login screen on first load
- Users must enter a valid session code to proceed
- The code is kept in memory for the browser session only
- All API calls are validated server-side

This is useful for:
- Preventing remote abuse (rate-limiting API costs)
- Multiple events using the same booth laptop
- Sharing a deployment among several teams
