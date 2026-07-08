# Anime/Superhero Shorts Automation — $0 pipeline

Generates a full short-form video: script → narration audio → word-level
timestamps → caption file → video assembly from your own curated
images/clips → upload to YouTube (private, with a toggleable caption track).

**Visuals are manually curated, not AI-generated.** An earlier version used
Pollinations.ai to auto-generate anime-style scene art, but that's been
retired (see `generateImages.js` — kept for reference, not part of the
active pipeline). You now drop your own images/clips into a per-video
folder before running the video stage.

## Setup

```
npm install
```

Copy `.env.example` to `.env` (or edit the existing `.env`) and fill in:

- `GEMINI_API_KEY` — Google AI Studio, free tier. https://aistudio.google.com/apikey
- `NARRATOR_VOICE` — optional, defaults to `am_michael`. Any Kokoro voice ID.

ffmpeg must be installed and on your PATH.
Windows: download the "essentials" build from https://www.gyan.dev/ffmpeg/builds/,
unzip it, add the `bin` folder to your System PATH, restart your terminal.

## Run the pipeline

Everything up through captions can run unattended:

```
npm run prep
```

This runs script → audio → timestamps → subtitles in sequence. Then:

1. **Drop your media in** — `generateVideo.js` will auto-create
   `output/<date>-media/` if it doesn't exist yet and tell you to fill it.
   Add images and/or video clips, named so alphabetical order = playback
   order (e.g. `01.jpg`, `02.mp4`, `03.jpg`...). Mix images and clips freely —
   images get a Ken Burns pan/zoom, clips play as-is (trimmed to a max
   length so one long clip can't eat the whole video).
2. `npm run video` — assembles everything into `output/<date>-final.mp4`,
   crossfading between clips, matched exactly to the narration's length.
3. `npm run upload` — uploads to YouTube as private, with the `.srt` from
   step 4 attached as a toggleable closed-caption track (not burned into
   the video — viewers turn it on/off via the CC button).

Or run each stage individually — every stage picks up the most recently
modified file from the previous one:

```
node generateScript.js        # Gemini writes narration + scene breakdown
node generateAudio.js         # Kokoro TTS narration -> WAV
node generatetimeStamps.js    # Whisper word-level timestamps
node generateSubtitles.js     # timestamps -> .srt (uploaded as CC track, not burned in)
node generateVideo.js         # your media + narration -> final .mp4
node uploadVideo.js           # uploads to YouTube, private, with CC track attached
```

## Dashboard

```
npm run dashboard
```

Opens a control panel at `http://localhost:4000` — buttons per stage, live
console output, script preview/editing, pronunciation-fix management, and
video history.

## Known gotchas

- **Subtitle path escaping**: ffmpeg's `subtitles`-adjacent path handling
  is picky about backslashes/drive-letter colons on Windows. If you ever
  see a path-related error after moving the project folder, that's the
  first thing to check.
- **Pronunciation fixes live in `data/pronunciations.json`** — `generateAudio.js`
  reads exactly that path. If you edit pronunciations by hand, make sure
  you're editing that file (not a stray copy elsewhere), or fixes will
  silently do nothing (no error — it just returns an empty dictionary if
  the file's missing at that exact path).
- **Filename casing matters if you ever deploy to Linux (Render, etc.)**
  even though Windows doesn't care. `uploadVideo.js`, `generateAudio.js`,
  etc. — keep exact casing consistent between the file on disk and every
  reference to it (package.json scripts, dashboard STAGES list).
- **`npm run prep` intentionally stops before video/upload** — those two
  need your manual media-drop step in between, so they're not part of the
  automated chain.

## Next up

TikTok upload (riskier — stricter API, may need business verification),
then wrapping the whole thing into a cron job for actual daily automation.