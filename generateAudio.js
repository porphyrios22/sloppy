const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { KokoroTTS, TextSplitterStream } = require("kokoro-js");
const { DEFAULT_VOICE, DEFAULT_SPEED } = require("./voices");

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

// Voice/speed picked in the dashboard's niche/voice picker are saved onto
// the script.json itself by generateScript.js, so each video's audio
// follows whatever was chosen for that run rather than one global setting.
// Falls back to NARRATOR_VOICE / NARRATOR_SPEED in .env, then to defaults —
// so this still works standalone if you're driving it from the CLI without
// ever touching the dashboard.
//
// Kokoro is a fixed-voicepack model (no cloning). Quality-graded male
// options, closest-to-farthest match for a casual conversational tone:
//   am_michael  "warm and trustworthy"     <- default, best match
//   am_fenrir   "deep and powerful"        <- more weight/gravity
//   am_puck     "playful and energetic"    <- lighter, less serious
//   am_adam     lower-graded, generic default — not recommended
// Full female options still available too (af_heart, af_bella, af_sarah, etc.)
function resolveVoiceAndSpeed(script) {
  const voice = script?.voice || process.env.NARRATOR_VOICE || DEFAULT_VOICE;
  const speed = script?.speed ?? (process.env.NARRATOR_SPEED ? parseFloat(process.env.NARRATOR_SPEED) : DEFAULT_SPEED);
  return { voice, speed };
}

const DTYPE = "q8"; // good balance of quality/speed on CPU; use "fp32" if you want max quality and don't mind slower load

const OUTPUT_DIR = path.join(__dirname, "output");
const PRONUNCIATIONS_FILE = path.join(__dirname, "data", "pronunciations.json");

function getLatestScript() {
  const files = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith("-script.json"))
    .map((f) => ({ name: f, time: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);

  if (!files.length) {
    throw new Error("No script found in output/. Run generateScript.js first.");
  }
  return path.join(OUTPUT_DIR, files[0].name);
}

// Kokoro is a general English model — it has no idea how to pronounce most
// anime character names (e.g. reads "Sasuke" as "Sa-sook"). Rather than
// fighting its phonemizer directly, swap known-tricky names for a plain
// English respelling that the model will read correctly using ordinary
// pronunciation rules. Expand data/pronunciations.json whenever you catch
// a new one — no code changes needed.
function loadPronunciations() {
  if (!fs.existsSync(PRONUNCIATIONS_FILE)) return {};
  const dict = JSON.parse(fs.readFileSync(PRONUNCIATIONS_FILE, "utf-8"));
  delete dict._comment;
  return dict;
}

function applyPronunciationFixes(text, dict) {
  const entries = Object.entries(dict);
  if (!entries.length) return text;

  // Longest names first, so e.g. a two-word name matches before either word alone would.
  entries.sort((a, b) => b[0].length - a[0].length);

  let result = text;
  for (const [name, respelling] of entries) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wholeWord = new RegExp(`\\b${escaped}\\b`, "gi");
    result = result.replace(wholeWord, respelling);
  }
  return result;
}

// The script file is structured JSON (scenes with narration + imagePrompt,
// plus the niche/format/voice/speed the dashboard was set to for this run).
// TTS just needs the full narration, so stitch the scenes back into one
// string, but return the whole parsed object too — main() needs voice/speed.
function loadScript(scriptPath) {
  const script = JSON.parse(fs.readFileSync(scriptPath, "utf-8"));
  if (!Array.isArray(script.scenes) || !script.scenes.length) {
    throw new Error(`No scenes found in ${scriptPath}`);
  }
  const fullNarration = script.scenes.map((s) => s.narration).join(" ");
  return { script, fullNarration };
}

// Kokoro reads best with real punctuation and no weird line breaks —
// collapse the script to clean single-spaced prose before feeding it in.
// Also strip markdown symbols (*, _, #, `, ~) since Kokoro will literally
// say "asterisk" etc. if the LLM slips any formatting through.
function cleanForTTS(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/[*_#`~]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Kokoro's underlying model has a hard input-length limit per generate() call
// (~500 tokens). Feeding a full ~600-word script in one call overruns that
// and crashes silently (native segfault, no JS error). Fix: stream the text
// through Kokoro's own splitter, which breaks it into safe sentence-level
// chunks, then stitch the resulting audio chunks into one file ourselves.
function writeWavFile(filePath, samples, sampleRate) {
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

  fs.writeFileSync(filePath, buffer);
}

async function main() {
  const scriptPath = getLatestScript();
  const { script, fullNarration: rawText } = loadScript(scriptPath);
  const { voice, speed } = resolveVoiceAndSpeed(script);
  const pronunciations = loadPronunciations();
  const text = applyPronunciationFixes(cleanForTTS(rawText), pronunciations);

  console.log(`Loading Kokoro model (${DTYPE})... this can take a minute on first run.`);
  const tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: DTYPE });

  console.log(`Generating audio for: ${path.basename(scriptPath)} (voice: ${voice}, speed: ${speed})`);

  const splitter = new TextSplitterStream();
  const stream = tts.stream(splitter, { voice, speed });
  splitter.push(text);
  splitter.close();

  const chunks = [];
  const chunkTexts = [];
  let sampleRate = null;
  let chunkCount = 0;

  for await (const { text: chunkText, audio } of stream) {
    chunks.push(audio.audio); // Float32Array of samples for this chunk
    chunkTexts.push(chunkText || "");
    sampleRate = audio.sampling_rate;
    chunkCount++;
    console.log(`  chunk ${chunkCount} generated (${audio.audio.length} samples)`);
  }

  if (!chunks.length) {
    throw new Error("No audio chunks were generated — check the script text isn't empty.");
  }

  // Kokoro trims silence off the edges of each generated chunk. Splicing
  // chunks back-to-back with zero gap deletes every natural pause a period
  // or comma would have produced — the audio reads punctuation-blind even
  // though the punctuation was there in the source text. Re-insert a short
  // silence between chunks, sized to whatever punctuation ended that chunk.
  function gapSecondsFor(chunkText) {
    const trimmed = chunkText.trim();
    const lastChar = trimmed[trimmed.length - 1];
    if (lastChar === "." || lastChar === "!" || lastChar === "?") return 0.35;
    if (lastChar === "," || lastChar === ";" || lastChar === ":") return 0.15;
    return 0.2; // default gap for chunk breaks with no trailing punctuation
  }

  const gapSamplesPerChunk = chunkTexts.map((t) => Math.round(gapSecondsFor(t) * sampleRate));

  const totalLength =
    chunks.reduce((sum, c) => sum + c.length, 0) +
    gapSamplesPerChunk.slice(0, -1).reduce((sum, g) => sum + g, 0);
  const combined = new Float32Array(totalLength);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    combined.set(chunks[i], offset);
    offset += chunks[i].length;
    if (i < chunks.length - 1) {
      offset += gapSamplesPerChunk[i]; // leaves zeros in place — silence
    }
  }

  const audioPath = scriptPath.replace("-script.json", "-audio.wav");
  writeWavFile(audioPath, combined, sampleRate);

  console.log(`Saved audio: ${audioPath}`);
}

main().catch((err) => {
  console.error("TTS failed:", err.message);
  process.exit(1);
});