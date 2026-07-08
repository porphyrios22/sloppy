require("dotenv").config();
const fs = require("fs");
const path = require("path");

const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY;
const OUTPUT_DIR = path.join(__dirname, "output");

// As of mid-2026 Pollinations moved everything behind gen.pollinations.ai and
// requires a Bearer key on every generation request (get a free one at
// enter.pollinations.ai — no payment needed for light/free-tier usage).
const IMAGE_ENDPOINT = "https://gen.pollinations.ai/image";
// Generate at a lower resolution than the final 1920x1080 output — generateVideo.js
// already upscales scene images 2x before the Ken Burns pan/zoom, so this costs no
// visible quality, but it keeps requests closer to Pollinations' free-tier path
// (their "unlimited free Flux" applies most reliably at/under default sizing —
// full 1080p requests were pulling from paid Pollen balance in testing).
const WIDTH = 1280;
const HEIGHT = 720; // still 16:9
const MODEL = "flux";

// Appended to every scene prompt so the whole video shares one consistent look,
// rather than trusting the LLM to remember to say "anime style" every time.
const STYLE_SUFFIX =
  ", anime art style, cel shaded, dramatic cinematic lighting, highly detailed illustration, no text, no watermark, no logo";

if (!POLLINATIONS_API_KEY) {
  console.error(
    "Missing POLLINATIONS_API_KEY in .env — get a free key at https://enter.pollinations.ai"
  );
  process.exit(1);
}

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fetches one image, retrying on 429 (rate limit) / 5xx with exponential backoff.
async function fetchImage(prompt, seed, attempt = 1) {
  const url = `${IMAGE_ENDPOINT}/${encodeURIComponent(prompt)}?model=${MODEL}&width=${WIDTH}&height=${HEIGHT}&seed=${seed}&nologo=true&safe=true`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${POLLINATIONS_API_KEY}` },
  });

  if (response.status === 429 || response.status >= 500) {
    if (attempt > 5) {
      throw new Error(`Pollinations still failing after ${attempt} attempts (status ${response.status})`);
    }
    const retryAfter = Number(response.headers.get("retry-after")) || 2 ** attempt;
    console.log(`  Rate limited/server error (${response.status}), retrying in ${retryAfter}s...`);
    await sleep(retryAfter * 1000);
    return fetchImage(prompt, seed, attempt + 1);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Pollinations image request failed (${response.status}): ${errText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function main() {
  const scriptPath = getLatestScript();
  const script = JSON.parse(fs.readFileSync(scriptPath, "utf-8"));

  if (!Array.isArray(script.scenes) || !script.scenes.length) {
    throw new Error(`No scenes found in ${scriptPath}`);
  }

  const dateStem = path.basename(scriptPath).replace("-script.json", "");
  const scenesDir = path.join(OUTPUT_DIR, `${dateStem}-scenes`);
  if (!fs.existsSync(scenesDir)) fs.mkdirSync(scenesDir, { recursive: true });

  console.log(`Generating ${script.scenes.length} scene images for ${script.franchise || "script"}...`);

  const imagePaths = [];
  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i];
    const imagePath = path.join(scenesDir, `scene-${i}.jpg`);

    if (fs.existsSync(imagePath)) {
      console.log(`  [${i + 1}/${script.scenes.length}] already exists, skipping: ${path.basename(imagePath)}`);
      imagePaths.push(imagePath);
      continue;
    }

    const prompt = scene.imagePrompt + STYLE_SUFFIX;
    // Fixed seed per scene index (not random) so re-runs of just this step
    // are reproducible; delete the scene's file if you want a fresh look on retry.
    const seed = 1000 + i;

    console.log(`  [${i + 1}/${script.scenes.length}] ${scene.imagePrompt.slice(0, 70)}...`);
    const imageBuffer = await fetchImage(prompt, seed);

    fs.writeFileSync(imagePath, imageBuffer);
    imagePaths.push(imagePath);

    // Be polite to the API between requests even though the key lifts the
    // hardest anonymous rate limit (1 req/15s).
    if (i < script.scenes.length - 1) await sleep(1500);
  }

  console.log(`Saved ${imagePaths.length} images to: ${scenesDir}`);
}

main().catch((err) => {
  console.error("Image generation failed:", err.message);
  process.exit(1);
});