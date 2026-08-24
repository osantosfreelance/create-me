# Setup & Installation Guide (Windows)

Step-by-step instructions to get **create-me** running on the booth laptop,
from a clean Windows machine to a working kiosk. Follow these in order.

---

## 1. Install Docker Desktop

1. Download Docker Desktop for Windows: https://www.docker.com/products/docker-desktop/
2. Run the installer. Keep the default option **"Use WSL 2 instead of Hyper-V"**
   checked if prompted (recommended, lighter-weight).
3. Reboot if the installer asks you to.
4. Launch **Docker Desktop** from the Start menu and wait for the whale icon
   in the system tray to stop animating (that means the Docker engine is
   running).
5. Verify it works — open **PowerShell** and run:

   ```powershell
   docker --version
   docker run hello-world
   ```

   You should see a "Hello from Docker!" message. If you get an error about
   WSL2 not being installed, Docker Desktop will prompt you to install it —
   follow that prompt, reboot, and re-launch Docker Desktop.

> If this laptop can't run Docker Desktop (e.g. WSL2/Hyper-V unsupported
> hardware, Windows Home edition issues), you can instead run the app
> directly with Node.js — see [Appendix: Running without Docker](#appendix-running-without-docker).

---

## 2. Get a Gemini API key

1. Go to https://aistudio.google.com/app/apikey.
2. Sign in with a Google account.
3. Click **"Create API key"** and copy it somewhere safe (you'll paste it in
   step 4). Treat this like a password — anyone with the key can generate
   images on your billing account.
4. Optional but recommended for an event: set a billing/usage cap or budget
   alert in the associated Google Cloud project, since the key is what
   controls cost (see the Cost estimate in `README.md`).

---

## 3. Get the project files onto the laptop

If you have the project as a folder already (e.g. copied via USB drive or
already cloned), just note its path — you'll need it in step 4. Otherwise,
if it's in a git repository:

```powershell
git clone <your-repo-url> create-me
cd create-me
```

---

## 4. Build and run the container

Open **PowerShell**, `cd` into the project folder, then:

```powershell
docker build -t create-me .
docker run -p 3000:3000 -e GEMINI_API_KEY=YOUR_KEY_HERE create-me
```

Replace `YOUR_KEY_HERE` with the API key from step 2.

Leave this PowerShell window open — it's running the server and shows logs.
The first `docker build` takes a minute or two (downloads a base image);
subsequent builds are much faster.

**Alternative using docker-compose** (equivalent, slightly more convenient
if you'll restart it often):

```powershell
$env:GEMINI_API_KEY = "YOUR_KEY_HERE"
docker compose up --build
```

To stop the app: press `Ctrl+C` in that window, or `docker compose down` if
you used compose.

---

## 5. Open it in a browser

1. On the same laptop, open a browser (Chrome or Edge recommended — Safari
   also supports webcam capture, but hasn't been tested here) and go to:

   ```
   http://localhost:3000
   ```

2. The browser will ask for **camera permission** — click **Allow**. If you
   accidentally block it, you can reset this in the browser's site settings
   (click the padlock/info icon in the address bar → Camera → Allow).
3. You should see a live camera preview with a **"Take Photo"** button. Take
   a test photo, enter a short prompt (e.g. "add a wizard hat"), and click
   **Generate** to confirm everything — API key, network, camera — works
   end to end before the event starts.

---

## 6. Set up kiosk mode for the event

So attendees see a clean, fullscreen app with no browser chrome:

**Chrome:**
```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk http://localhost:3000
```

**Edge:**
```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --kiosk http://localhost:3000
```

Press `Alt+F4` to exit kiosk mode when the event is over.

Tips for a booth setup:
- Disable Windows sleep/screen-lock while the booth is active (Settings →
  System → Power & sleep → set both to "Never" for the duration of the
  event, then restore afterward).
- If using an external/USB webcam instead of a built-in one, plug it in
  *before* opening the browser tab, and confirm the browser is using the
  right camera (address bar padlock → Camera, if multiple are detected).
- The app resets itself to the camera screen after 90 seconds of
  inactivity, so you don't need to manually reset between attendees.

---

## 7. Between events / resetting

Nothing is stored on disk (see the Privacy section in `README.md`), so
there's no cleanup needed. To fully reset for a new event, just stop and
restart the container:

```powershell
docker restart create-me
```

(or `Ctrl+C` then re-run the `docker run`/`docker compose up` command).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `docker: command not found` in PowerShell | Docker Desktop isn't installed or not on PATH — reinstall, and make sure Docker Desktop is actually running (whale icon in tray). |
| Docker Desktop won't start / WSL2 errors | Run `wsl --update` in PowerShell (as admin), reboot, relaunch Docker Desktop. |
| Page won't load at `localhost:3000` | Check the PowerShell window running the container for errors; make sure no other app is using port 3000 (`netstat -ano \| findstr :3000`), or change the port mapping, e.g. `-p 8080:3000` and browse to `localhost:8080`. |
| "Server is not configured with GEMINI_API_KEY" | You forgot `-e GEMINI_API_KEY=...` on `docker run` (or the env var wasn't set before `docker compose up`). Stop the container and re-run with the key set. |
| Camera preview is black / permission denied | Check browser camera permissions (padlock icon → Camera → Allow) and make sure no other app (Zoom/Teams/Camera app) is already using the webcam. |
| Image generation fails / times out | Check internet connectivity on the laptop — the app needs to reach `generativelanguage.googleapis.com`. Corporate/venue Wi-Fi with strict firewalls can block this. |
| "Too many requests" / 429 errors | Built-in rate limiting (see README "Guardrails" section) — wait a few seconds and retry; this is expected under heavy rapid use. |

---

## Appendix: Running without Docker

If Docker isn't an option on the booth laptop, you can run it directly with
Node.js 18+ instead:

```powershell
npm install
$env:GEMINI_API_KEY = "YOUR_KEY_HERE"
npm start
```

Then open `http://localhost:3000` as in step 5. Functionally identical to
the Docker route — Docker is just recommended for easy setup/teardown and
to avoid needing Node.js installed and configured on the booth laptop.
