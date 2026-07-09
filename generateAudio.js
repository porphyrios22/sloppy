const fs = require("fs");
const path = require("path");
require("dotenv").config();

// -----------------------------------------------------------------------
// API key pool
// -----------------------------------------------------------------------
// Put all 4 keys in one comma-separated env var:
//   ELEVENLABS_API_KEYS=key1,key2,key3,key4
// We round-robin across them per chunk request, and if a key comes back
// rate-limited/quota-exhausted (429) we automatically retry that same
// chunk on the next key in the pool instead of failing the whole run.
const API_KEYS = (process.env.ELEVENLABS_API_KEYS || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

if (!API_KEYS.length) {
  throw new Error(
    "No ElevenLabs API keys found. Set ELEVENLABS_API_KEYS=key1,key2,key3,key4 in your .env"
  );
}

// Deterministic round robin: chunk N always starts on key (N % pool size),
// regardless of what happened on earlier chunks. A failure on one chunk
// walks forward through the pool for retries but never shifts which key
// the *next* chunk starts on.
function keyForAttempt(chunkIndex, attempt) {
  return API_KEYS[(chunkIndex + attempt) % API_KEYS.length];
}

// -----------------------------------------------------------------------
// Voice / model config
// -----------------------------------------------------------------------
// Kokoro's voice IDs (am_michael, af_bella, etc.) don't mean anything to
// ElevenLabs, so these defaults are ElevenLabs voice IDs instead. Override
// per-run via script.voice (same field the dashboard already writes), or
// globally via .env. "Rachel" is ElevenLabs' stock default voice ID.
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
const DEFAULT_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";
const DEFAULT_STABILITY = process.env.ELEVENLABS_STABILITY
  ? parseFloat(process.env.ELEVENLABS_STABILITY)
  : 0.5;
const DEFAULT_SIMILARITY = process.env.ELEVENLABS_SIMILARITY
  ? parseFloat(process.env.ELEVENLABS_SIMILARITY)
  : 0.75;
// Optional: only eleven_turbo/eleven_multilingual v2+ models honor "speed".
// Leave unset (null) to just use the model's natural pace.
const DEFAULT_SPEED = process.env.ELEVENLABS_SPEED
  ? parseFloat(process.env.ELEVENLABS_SPEED)
  : null;

// script.voice from the dashboard is expected to hold an ElevenLabs voice
// ID going forward. script.speed still maps onto voice_settings.speed.
function resolveVoiceAndSpeed(script) {
  const voice = script?.voice || DEFAULT_VOICE_ID;
  const speed = script?.speed ?? DEFAULT_SPEED;
  return { voice, speed };
}

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

function loadPronunciations() {
  if (!fs.existsSync(PRONUNCIATIONS_FILE)) return {};
  const dict = JSON.parse(fs.readFileSync(PRONUNCIATIONS_FILE, "utf-8"));
  delete dict._comment;
  return dict;
}

function applyPronunciationFixes(text, dict) {
  const entries = Object.entries(dict);
  if (!entries.length) return text;

  entries.sort((a, b) => b[0].length - a[0].length);

  let result = text;
  for (const [name, respelling] of entries) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wholeWord = new RegExp(`\\b${escaped}\\b`, "gi");
    result = result.replace(wholeWord, respelling);
  }
  return result;
}

function loadScript(scriptPath) {
  const script = JSON.parse(fs.readFileSync(scriptPath, "utf-8"));
  if (!Array.isArray(script.scenes) || !script.scenes.length) {
    throw new Error(`No scenes found in ${scriptPath}`);
  }
  const fullNarration = script.scenes.map((s) => s.narration).join(" ");
  return { script, fullNarration };
}

function cleanForTTS(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/[*_#`~]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// -----------------------------------------------------------------------
// Chunking
// -----------------------------------------------------------------------
// ElevenLabs will accept large inputs, but very long single requests are
// slower, more likely to time out, and make retries expensive (you'd
// re-pay for the whole thing on a single dropped connection). Split on
// sentence boundaries into ~2500-char chunks instead, similar in spirit
// to Kokoro's own splitter, and stitch the resulting mp3s together.
const MAX_CHUNK_CHARS = 2500;

function splitIntoChunks(text) {
  const sentences = text.match(/[^.!?]+[.!?]+(\s+|$)/g) || [text];
  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    if (current.length + sentence.length > MAX_CHUNK_CHARS && current) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// -----------------------------------------------------------------------
// ElevenLabs request with key rotation + 429 failover
// -----------------------------------------------------------------------
async function synthesizeChunk({ text, previousText, nextText, voice, speed }) {
  const voiceSettings = {
    stability: DEFAULT_STABILITY,
    similarity_boost: DEFAULT_SIMILARITY,
  };
  if (speed) voiceSettings.speed = speed;

  const body = {
    text,
    model_id: DEFAULT_MODEL_ID,
    voice_settings: voiceSettings,
  };
  if (previousText) body.previous_text = previousText;
  if (nextText) body.next_text = nextText;

  let lastErr;
  // Try each key at most once per chunk before giving up.
  for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
    const key = nextKey();
    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": key,
          },
          body: JSON.stringify(body),
        }
      );

      if (res.status === 429) {
        lastErr = new Error(`Rate limited on key ending ...${key.slice(-4)}`);
        console.log(`  key ...${key.slice(-4)} rate-limited, trying next key`);
        continue;
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        throw new Error(`ElevenLabs error ${res.status}: ${errText}`);
      }

      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      lastErr = err;
      // Network errors: also worth trying the next key before failing.
      console.log(`  key ...${key.slice(-4)} failed (${err.message}), trying next key`);
    }
  }

  throw lastErr || new Error("All API keys failed for this chunk.");
}

async function main() {
  const scriptPath = getLatestScript();
  const { script, fullNarration: rawText } = loadScript(scriptPath);
  const { voice, speed } = resolveVoiceAndSpeed(script);
  const pronunciations = loadPronunciations();
  const text = applyPronunciationFixes(cleanForTTS(rawText), pronunciations);

  const chunks = splitIntoChunks(text);
  console.log(
    `Generating audio for: ${path.basename(scriptPath)} (voice: ${voice}, speed: ${
      speed ?? "default"
    }, ${chunks.length} chunk(s), ${API_KEYS.length} key(s) in pool)`
  );

  const audioBuffers = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkText = chunks[i];
    const previousText = chunks[i - 1];
    const nextText = chunks[i + 1];

    console.log(`  chunk ${i + 1}/${chunks.length} (${chunkText.length} chars)...`);
    const audioBuffer = await synthesizeChunk({
      text: chunkText,
      previousText,
      nextText,
      voice,
      speed,
    });
    audioBuffers.push(audioBuffer);
    console.log(`  chunk ${i + 1} done (${audioBuffer.length} bytes)`);
  }

  if (!audioBuffers.length) {
    throw new Error("No audio was generated — check the script text isn't empty.");
  }

  // Simple buffer concatenation. Consecutive MP3 frames generally decode
  // fine back-to-back; there's no forced silence re-inserted between
  // chunks the way the old Kokoro script did, since ElevenLabs' own
  // previous_text/next_text context already keeps prosody/pauses natural
  // across the split points.
  const combined = Buffer.concat(audioBuffers);

  const audioPath = scriptPath.replace("-script.json", "-audio.mp3");
  fs.writeFileSync(audioPath, combined);

  console.log(`Saved audio: ${audioPath}`);
}

main().catch((err) => {
  console.error("TTS failed:", err.message);
  process.exit(1);
});