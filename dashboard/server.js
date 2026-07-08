const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { spawn } = require("child_process");
const { NICHE_LIST, NICHES } = require("../niches");
const { VOICES, DEFAULT_VOICE, DEFAULT_SPEED, MIN_SPEED, MAX_SPEED } = require("../voices");

const PROJECT_ROOT = path.join(__dirname, "..");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "output");
const PRONUNCIATIONS_FILE = path.join(PROJECT_ROOT, "data", "pronunciations.json");
const PENDING_RUN_FILE = path.join(PROJECT_ROOT, "data", "pending-run.json");
const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 4000;

const STAGES = [
  { id: "script", label: "1. Generate Script", file: "generateScript.js" },
  { id: "audio", label: "2. Generate Audio", file: "generateAudio.js" },
  { id: "timestamps", label: "3. Generate Timestamps", file: "generatetimeStamps.js" },
  { id: "subtitles", label: "4. Generate Subtitles", file: "generateSubtitles.js" },
  { id: "video", label: "5. Assemble Video", file: "generateVideo.js" },
  { id: "upload", label: "6. Upload to YouTube", file: "uploadVideo.js" },
];

// Same "which video is this" logic generateVideo.js uses — whatever script
// was generated most recently defines the current video's date-stamped stem.
function getCurrentStem() {
  if (!fs.existsSync(OUTPUT_DIR)) return null;
  const files = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith("-script.json"))
    .map((f) => ({ name: f, time: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  return files.length ? files[0].name.replace("-script.json", "") : null;
}

function getMediaDir(stem) {
  return path.join(OUTPUT_DIR, `${stem}-media`);
}

const MEDIA_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov", ".m4v", ".webm", ".mkv"]);

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

fs.mkdirSync(path.join(PROJECT_ROOT, ".upload-tmp"), { recursive: true });

// --- In-memory run state + simple pub/sub for log streaming -------------

let currentRun = null; // { stageId, logs: string[], running: bool, exitCode: number|null }
let sseClients = [];

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((res) => res.write(payload));
}

app.get("/api/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  sseClients.push(res);

  if (currentRun) {
    res.write(`event: state\ndata: ${JSON.stringify(currentRun)}\n\n`);
  }

  req.on("close", () => {
    sseClients = sseClients.filter((c) => c !== res);
  });
});

app.get("/api/stages", (req, res) => {
  res.json(STAGES);
});

// --- Run config (niche / format / voice / speed picker) -------------------

app.get("/api/niches", (req, res) => {
  res.json(NICHE_LIST);
});

app.get("/api/voices", (req, res) => {
  res.json({ voices: VOICES, defaultVoice: DEFAULT_VOICE, defaultSpeed: DEFAULT_SPEED, minSpeed: MIN_SPEED, maxSpeed: MAX_SPEED });
});

app.get("/api/run-config", (req, res) => {
  if (!fs.existsSync(PENDING_RUN_FILE)) {
    return res.json({ niche: "anime-superhero", customNiche: "", format: "long", voice: DEFAULT_VOICE, speed: DEFAULT_SPEED });
  }
  res.json(JSON.parse(fs.readFileSync(PENDING_RUN_FILE, "utf-8")));
});

// Saved right before the "script" stage runs (see runStage() in index.html).
// generateScript.js reads this same file to decide niche/format/voice/speed
// for that run, then bakes the choices into the script.json itself so every
// downstream stage (audio, video, upload) just reads them off that file.
app.post("/api/run-config", (req, res) => {
  const { niche, customNiche, format, voice, speed } = req.body || {};

  if (niche && !NICHES[niche]) {
    return res.status(400).json({ error: `Unknown niche "${niche}".` });
  }
  if (NICHES[niche]?.isCustom && !(customNiche || "").trim()) {
    return res.status(400).json({ error: "Custom niche selected but no description was provided." });
  }
  if (format && !["long", "short"].includes(format)) {
    return res.status(400).json({ error: `format must be "long" or "short", got "${format}".` });
  }
  if (speed !== undefined && (typeof speed !== "number" || speed < MIN_SPEED || speed > MAX_SPEED)) {
    return res.status(400).json({ error: `speed must be a number between ${MIN_SPEED} and ${MAX_SPEED}.` });
  }

  const config = {
    niche: niche || "anime-superhero",
    customNiche: (customNiche || "").trim(),
    format: format || "long",
    voice: voice || DEFAULT_VOICE,
    speed: speed ?? DEFAULT_SPEED,
  };

  fs.mkdirSync(path.dirname(PENDING_RUN_FILE), { recursive: true });
  fs.writeFileSync(PENDING_RUN_FILE, JSON.stringify(config, null, 2));
  res.json({ saved: true, config });
});

// --- Voice preview ("Test voice" button) ----------------------------------
//
// Same Kokoro model/voicepack as generateAudio.js, but kept as a lazy
// singleton here instead of loading it at server startup — most dashboard
// sessions never touch this, and the model load is the expensive part
// (~a minute the first time). First preview request pays that cost; every
// request after reuses the loaded model. Concurrent first requests share
// the same in-flight load promise instead of racing to load it twice.
const TTS_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const TTS_DTYPE = "q8";
const VOICE_PREVIEW_MAX_CHARS = 300;

let ttsInstancePromise = null;
let kokoroModule = null;
function getTTS() {
  if (!ttsInstancePromise) {
    // Required lazily (not at module top-level) so that a broken TTS
    // dependency chain (e.g. a missing native module) only breaks this one
    // endpoint on first use, instead of preventing the whole dashboard —
    // niche/voice pickers, stage running, etc. — from starting at all.
    ttsInstancePromise = Promise.resolve()
      .then(() => (kokoroModule = require("kokoro-js")))
      .then(({ KokoroTTS }) => KokoroTTS.from_pretrained(TTS_MODEL_ID, { dtype: TTS_DTYPE }))
      .catch((err) => {
        ttsInstancePromise = null; // let the next request retry instead of caching a failure forever
        throw err;
      });
  }
  return ttsInstancePromise;
}

// Mirrors writeWavFile() in generateAudio.js — duplicated rather than
// imported since that file's version writes straight to disk and this one
// needs an in-memory Buffer to send as the HTTP response body.
function encodeWav(samples, sampleRate) {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), offset);
  }
  return buffer;
}

app.post("/api/voice-preview", async (req, res) => {
  const { voice, speed, text } = req.body || {};

  if (!voice || !VOICES.some((v) => v.id === voice)) {
    return res.status(400).json({ error: `Unknown voice "${voice}".` });
  }
  if (typeof speed !== "number" || speed < MIN_SPEED || speed > MAX_SPEED) {
    return res.status(400).json({ error: `speed must be a number between ${MIN_SPEED} and ${MAX_SPEED}.` });
  }
  const cleanText = (text || "").replace(/[*_#`~]/g, "").trim();
  if (!cleanText) {
    return res.status(400).json({ error: "text must not be empty." });
  }
  if (cleanText.length > VOICE_PREVIEW_MAX_CHARS) {
    return res.status(400).json({ error: `Keep the preview text under ${VOICE_PREVIEW_MAX_CHARS} characters.` });
  }

  try {
    const tts = await getTTS();
    const { TextSplitterStream } = kokoroModule;

    const splitter = new TextSplitterStream();
    const stream = tts.stream(splitter, { voice, speed });
    splitter.push(cleanText);
    splitter.close();

    const chunks = [];
    let sampleRate = null;
    for await (const { audio } of stream) {
      chunks.push(audio.audio);
      sampleRate = audio.sampling_rate;
    }
    if (!chunks.length) throw new Error("No audio was generated for that text.");

    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    const wavBuffer = encodeWav(combined, sampleRate);
    res.set({ "Content-Type": "audio/wav", "Content-Length": wavBuffer.length });
    res.send(wavBuffer);
  } catch (err) {
    console.error("voice preview failed:", err);
    res.status(500).json({ error: err.message || "Failed to generate voice preview." });
  }
});

app.post("/api/run/:stageId", (req, res) => {
  const stage = STAGES.find((s) => s.id === req.params.stageId);
  if (!stage) return res.status(404).json({ error: "Unknown stage" });

  if (currentRun && currentRun.running) {
    return res.status(409).json({ error: `Stage "${currentRun.stageId}" is already running.` });
  }

  currentRun = { stageId: stage.id, logs: [], running: true, exitCode: null };
  broadcast("state", currentRun);

  const child = spawn("node", [stage.file], { cwd: PROJECT_ROOT });

  const pushLog = (chunk) => {
    const text = chunk.toString();
    currentRun.logs.push(text);
    broadcast("log", { text });
  };

  child.stdout.on("data", pushLog);
  child.stderr.on("data", pushLog);

  child.on("close", (code) => {
    currentRun.running = false;
    currentRun.exitCode = code;
    broadcast("state", currentRun);
  });

  res.json({ started: stage.id });
});

// --- Script preview / edit ------------------------------------------------

function getLatestFile(suffix) {
  if (!fs.existsSync(OUTPUT_DIR)) return null;
  const files = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith(suffix))
    .map((f) => ({ name: f, time: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  return files.length ? path.join(OUTPUT_DIR, files[0].name) : null;
}

app.get("/api/script", (req, res) => {
  const scriptPath = getLatestFile("-script.json");
  if (!scriptPath) return res.status(404).json({ error: "No script generated yet." });
  const content = JSON.parse(fs.readFileSync(scriptPath, "utf-8"));
  res.json({ filename: path.basename(scriptPath), content });
});

app.post("/api/script", (req, res) => {
  const scriptPath = getLatestFile("-script.json");
  if (!scriptPath) return res.status(404).json({ error: "No script to update." });

  try {
    // Validate shape before writing — don't let a bad edit corrupt the file
    // that every downstream stage depends on.
    const { narration } = req.body;
    if (typeof narration !== "string" || !narration.trim()) {
      throw new Error("narration must be a non-empty string");
    }

    const existing = JSON.parse(fs.readFileSync(scriptPath, "utf-8"));

    // IMPORTANT: generateAudio.js and uploadVideo.js both read
    // scenes[].narration, NOT a top-level `narration` field — there isn't
    // one in the script shape generateScript.js produces. The editor's
    // textarea is scenes joined with "\n\n" (see index.html), so split the
    // edited text back the same way and write it into scenes[] itself.
    // Writing a top-level `narration` key here (the old behavior) silently
    // orphaned every edit: nothing downstream ever read it.
    const oldScenes = existing.scenes || [];
    const paragraphs = narration
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);

    if (!paragraphs.length) throw new Error("narration must contain at least one scene of text");

    const scenes = paragraphs.map((p, i) => ({
      narration: p,
      // Keep the original imagePrompt when a scene still lines up by index.
      // Added/removed paragraphs just get an empty prompt — imagePrompt
      // isn't used by the current manual-media pipeline anyway.
      imagePrompt: oldScenes[i]?.imagePrompt || "",
    }));

    const updated = { ...existing, scenes };
    fs.writeFileSync(scriptPath, JSON.stringify(updated, null, 2));
    res.json({ saved: true, sceneCount: scenes.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Video history ---------------------------------------------------------

app.get("/api/history", (req, res) => {
  if (!fs.existsSync(OUTPUT_DIR)) return res.json([]);

  const finals = fs.readdirSync(OUTPUT_DIR).filter((f) => f.endsWith("-final.mp4"));

  const history = finals
    .map((f) => {
      const baseName = f.replace("-final.mp4", "");
      const scriptPath = path.join(OUTPUT_DIR, `${baseName}-script.json`);
      const youtubePath = path.join(OUTPUT_DIR, `${baseName}-youtube.json`);

      const script = fs.existsSync(scriptPath) ? JSON.parse(fs.readFileSync(scriptPath, "utf-8")) : {};
      const youtube = fs.existsSync(youtubePath) ? JSON.parse(fs.readFileSync(youtubePath, "utf-8")) : null;

      // subject/focus/niche/format are the current field names. Older
      // videos generated before the niche picker existed only have
      // franchise/characterFocus and no niche/format at all — fall back
      // gracefully so old history entries still render something sensible.
      return {
        date: script.date || baseName,
        subject: script.subject || script.franchise || null,
        focus: script.focus || script.characterFocus || null,
        niche: script.niche || (script.franchise ? "anime-superhero" : null),
        format: script.format || "long",
        videoFile: f,
        youtube,
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  res.json(history);
});

app.get("/api/video/:filename", (req, res) => {
  const filePath = path.join(OUTPUT_DIR, req.params.filename);
  if (!filePath.startsWith(OUTPUT_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).end();
  }
  res.sendFile(filePath);
});

// Lets the dashboard play back the narration right after generating it —
// useful as a checkpoint before spending time on images/video downstream.
app.get("/api/audio/latest", (req, res) => {
  const audioPath = getLatestFile("-audio.wav");
  if (!audioPath) return res.status(404).end();
  res.sendFile(audioPath);
});

// --- Media (images/clips for the current video) ---------------------------

// Files are staged into a temp dir first, then moved+renamed in the actual
// upload order once we know the current stem — avoids naming collisions and
// keeps the "alphabetical order = playback order" contract generateVideo.js
// relies on.
const upload = multer({ dest: path.join(PROJECT_ROOT, ".upload-tmp") });

app.get("/api/media", (req, res) => {
  const stem = getCurrentStem();
  if (!stem) return res.json({ stem: null, files: [] });

  const mediaDir = getMediaDir(stem);
  if (!fs.existsSync(mediaDir)) return res.json({ stem, files: [] });

  const files = fs
    .readdirSync(mediaDir)
    .filter((f) => MEDIA_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .sort();
  res.json({ stem, files });
});

app.post("/api/media/upload", upload.array("files"), (req, res) => {
  const stem = getCurrentStem();
  if (!stem) return res.status(400).json({ error: "No script generated yet — run Generate Script first." });

  const mediaDir = getMediaDir(stem);
  fs.mkdirSync(mediaDir, { recursive: true });

  // Continue numbering after the HIGHEST index actually in use — not just a
  // count of files present. Counting alone breaks the moment a file gets
  // deleted: e.g. delete "01.mp4" leaving "02.jpg", and a naive count of 1
  // would hand the next upload index "01" again, silently overwriting
  // nothing that exists... but if two files remain after a delete (say
  // "01.png" and "02.jpg"), a count of 2 hands out "02" again and clobbers
  // the real "02.jpg". Scanning for the actual max prefix avoids this
  // regardless of what's been deleted in between.
  const existing = fs.readdirSync(mediaDir).filter((f) => MEDIA_EXTENSIONS.has(path.extname(f).toLowerCase()));
  let maxIndex = -1;
  for (const f of existing) {
    const match = f.match(/^(\d+)/);
    if (match) maxIndex = Math.max(maxIndex, parseInt(match[1], 10));
  }
  let nextIndex = maxIndex + 1;

  const saved = [];
  for (const file of req.files || []) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!MEDIA_EXTENSIONS.has(ext)) {
      fs.unlinkSync(file.path); // reject silently-unsupported types, clean up temp file
      continue;
    }
    const filename = `${String(nextIndex).padStart(2, "0")}${ext}`;
    fs.renameSync(file.path, path.join(mediaDir, filename));
    saved.push(filename);
    nextIndex++;
  }

  res.json({ stem, saved });
});

app.delete("/api/media/:filename", (req, res) => {
  const stem = getCurrentStem();
  if (!stem) return res.status(404).json({ error: "No current video." });

  const mediaDir = getMediaDir(stem);
  const filePath = path.join(mediaDir, req.params.filename);

  // Guard against path traversal — filename must resolve to inside mediaDir.
  if (!filePath.startsWith(mediaDir) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found." });
  }

  fs.unlinkSync(filePath);
  res.json({ deleted: true });
});

app.get("/api/media/file/:filename", (req, res) => {
  const stem = getCurrentStem();
  if (!stem) return res.status(404).end();
  const filePath = path.join(getMediaDir(stem), req.params.filename);
  if (!filePath.startsWith(getMediaDir(stem)) || !fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

// --- Pronunciation dictionary ----------------------------------------------

app.get("/api/pronunciations", (req, res) => {
  if (!fs.existsSync(PRONUNCIATIONS_FILE)) return res.json({});
  const dict = JSON.parse(fs.readFileSync(PRONUNCIATIONS_FILE, "utf-8"));
  delete dict._comment;
  res.json(dict);
});

app.post("/api/pronunciations", (req, res) => {
  const { word, respelling } = req.body;
  if (!word || !respelling) {
    return res.status(400).json({ error: "word and respelling are both required." });
  }

  const dict = fs.existsSync(PRONUNCIATIONS_FILE) ? JSON.parse(fs.readFileSync(PRONUNCIATIONS_FILE, "utf-8")) : {};
  dict[word] = respelling;
  fs.writeFileSync(PRONUNCIATIONS_FILE, JSON.stringify(dict, null, 2));
  res.json({ saved: true });
});

app.delete("/api/pronunciations/:word", (req, res) => {
  const dict = fs.existsSync(PRONUNCIATIONS_FILE) ? JSON.parse(fs.readFileSync(PRONUNCIATIONS_FILE, "utf-8")) : {};
  delete dict[req.params.word];
  fs.writeFileSync(PRONUNCIATIONS_FILE, JSON.stringify(dict, null, 2));
  res.json({ deleted: true });
});

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});