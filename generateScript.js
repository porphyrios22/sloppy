require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { getNiche } = require("./niches");
const { DEFAULT_VOICE, DEFAULT_SPEED } = require("./voices");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash";

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY in .env");
  process.exit(1);
}

const HISTORY_FILE = path.join(__dirname, "data", "history.json");
const PENDING_RUN_FILE = path.join(__dirname, "data", "pending-run.json");
const FRANCHISE_LOOKBACK = 8; // how many past runs' subjects get explicitly banned from repeating, per niche

const FORMATS = {
  long: { id: "long", minScenes: 5, maxScenes: 8, minWords: 550, maxWords: 600, targetLabel: "~4 minutes spoken" },
  short: { id: "short", minScenes: 3, maxScenes: 5, minWords: 110, maxWords: 160, targetLabel: "~45-60 seconds spoken" },
};

// The dashboard writes this file right before triggering the "script" stage,
// with whatever the user picked in the UI (niche, format, voice, speed).
// CLI-only users can skip the dashboard entirely and set NICHE / FORMAT /
// CUSTOM_NICHE / NARRATOR_VOICE / NARRATOR_SPEED as env vars instead — the
// pending-run file just wins if both are present, since it's the more
// recent/explicit choice.
function loadRunConfig() {
  let fromFile = {};
  if (fs.existsSync(PENDING_RUN_FILE)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(PENDING_RUN_FILE, "utf-8"));
    } catch (err) {
      console.warn(`Warning: ${PENDING_RUN_FILE} was unreadable (${err.message}) — ignoring it.`);
    }
  }

  const nicheId = fromFile.niche || process.env.NICHE || "anime-superhero";
  const customNiche = fromFile.customNiche || process.env.CUSTOM_NICHE || "";
  const formatId = fromFile.format || process.env.FORMAT || "long";
  const voice = fromFile.voice || process.env.NARRATOR_VOICE || DEFAULT_VOICE;
  const speed = fromFile.speed ?? (process.env.NARRATOR_SPEED ? parseFloat(process.env.NARRATOR_SPEED) : DEFAULT_SPEED);

  const format = FORMATS[formatId] || FORMATS.long;
  const niche = getNiche(nicheId);

  if (niche.isCustom && !customNiche.trim()) {
    throw new Error(
      `Niche is set to "custom" but no customNiche text was provided. Set it in the dashboard's niche picker, or pass CUSTOM_NICHE="..." as an env var.`
    );
  }

  return { niche, customNiche: customNiche.trim(), format, voice, speed };
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
}

function saveHistory(entry) {
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const history = loadHistory();
  history.push(entry);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function pickTopic(niche) {
  if (!niche.topicPool || !niche.topicPool.length) return null; // custom niches have no fixed pool
  const history = loadHistory();
  const usedAngles = history
    .filter((h) => h.niche === niche.id)
    .slice(-10)
    .map((h) => h.angle);
  const fresh = niche.topicPool.filter((t) => !usedAngles.includes(t));
  const pool = fresh.length ? fresh : niche.topicPool;
  return pool[Math.floor(Math.random() * pool.length)];
}

// "Vary it, don't default to the obvious choice" as a soft instruction isn't
// reliable — models still gravitate to one or two go-to subjects over and
// over. Explicitly banning the last N used subjects by name forces real
// variety instead of hoping for it. Scoped per-niche so a run of true-crime
// videos doesn't get banned subjects from your anime runs.
function getRecentSubjects(niche) {
  if (!niche.banRepeats) return [];
  const history = loadHistory();
  return [
    ...new Set(
      history
        .filter((h) => h.niche === niche.id)
        .slice(-FRANCHISE_LOOKBACK)
        .map((h) => h.subject)
        .filter(Boolean)
    ),
  ];
}

function buildPrompt({ niche, customNiche, format, angle, bannedSubjects }) {
  const banClause = bannedSubjects.length
    ? `\n\nDo NOT use any of these ${niche.subjectNoun}s — they've already been covered recently: ${bannedSubjects.join(", ")}. Pick something genuinely different.`
    : "";

  const topicLine = niche.isCustom
    ? `Write a script about the following: ${customNiche}.`
    : `Pick a specific ${niche.subjectNoun} yourself. Write about ${angle} for that ${niche.subjectNoun}.`;

  const styleGuidance = niche.isCustom
    ? "Stay factually accurate. If you're not confident about a specific fact, favor a more general true statement over a specific but risky one."
    : niche.styleGuidance;

  return `You are writing a spoken-word script for a short-form video (TikTok/YouTube ${
    format.id === "short" ? "Shorts" : "video"
  }).

${topicLine}${banClause}

${styleGuidance}

Return the script broken into ${format.minScenes} to ${format.maxScenes} scenes. Each scene is a contiguous chunk of the narration (they concatenate in order to form the full ~${format.minWords}-${format.maxWords} word script, ${format.targetLabel}). Also write a visual image prompt for each scene describing what should appear on screen while that chunk is narrated.

Rules for narration text (combined across all scenes):
- ~${format.minWords}-${format.maxWords} words total, spoken aloud naturally — short punchy sentences, hook in the first line, no filler like "today we're talking about."
- No titles, no markdown, no stage directions, no "[pause]" markers, no emojis, no asterisks/underscores/pound signs/backticks — convey emphasis through word choice only.
- End on a strong closing line, not a call-to-action.
- Plain prose only, no bullet points or lists.
- Each scene's narration should be roughly 2-5 sentences — a natural paragraph break, not a mid-sentence cut.
${format.id === "short" ? "- This is a Short: get to the point fast, no slow build-up — the hook IS the first sentence." : ""}

Rules for image prompts:
- Each imagePrompt is a standalone visual description (3-6 sentences) of a specific moment, subject, or scene — written for an AI image generator, not the viewer.
- Describe composition, subject appearance/pose, setting, and mood concretely. Don't just repeat the narration text.
- Do not include any text, logos, or watermarks in the described image.
${format.id === "short" ? "- Describe images that work in a tall 9:16 vertical frame (centered subject, not a wide landscape composition)." : ""}

Respond with ONLY valid JSON, no markdown code fences, matching exactly this shape:
{
  "subject": "string - the ${niche.subjectNoun} this video is about",
  "focus": "string - the ${niche.focusNoun} this episode centers on",
  "scenes": [
    { "narration": "string", "imagePrompt": "string" }
  ]
}`;
}

async function generateScript(runConfig) {
  const { niche, format } = runConfig;
  const angle = pickTopic(niche);
  const bannedSubjects = getRecentSubjects(niche);
  const prompt = buildPrompt({ ...runConfig, angle, bannedSubjects });

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 1.2, // nudged up from 1.0 — helps break the "same subject every time" pattern
          maxOutputTokens: 4000,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

  if (!raw) {
    throw new Error("No text returned from Gemini — check response shape: " + JSON.stringify(data));
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error("Gemini did not return valid JSON:\n" + raw);
  }

  if (!Array.isArray(parsed.scenes) || parsed.scenes.length < 1) {
    throw new Error("Response JSON has no usable scenes array:\n" + JSON.stringify(parsed));
  }
  if (parsed.scenes.length < format.minScenes || parsed.scenes.length > format.maxScenes) {
    console.warn(
      `Warning: expected ${format.minScenes}-${format.maxScenes} scenes, got ${parsed.scenes.length}. Continuing anyway.`
    );
  }
  for (const [i, scene] of parsed.scenes.entries()) {
    if (!scene.narration || !scene.imagePrompt) {
      throw new Error(`Scene ${i} is missing narration or imagePrompt: ${JSON.stringify(scene)}`);
    }
  }

  // If the model ignored the ban clause anyway, catch it here rather than
  // silently saving a repeat — fail loudly so it's obvious and re-runnable.
  if (bannedSubjects.includes(parsed.subject)) {
    throw new Error(
      `Gemini picked "${parsed.subject}" despite it being on the recent-${niche.subjectNoun} ban list (${bannedSubjects.join(
        ", "
      )}). Just re-run — this is a model compliance miss, not a bug.`
    );
  }

  return { angle, subject: parsed.subject, focus: parsed.focus, scenes: parsed.scenes };
}

async function main() {
  const runConfig = loadRunConfig();
  const { niche, format, voice, speed } = runConfig;

  console.log(`Generating script — niche: ${niche.label}, format: ${format.id}, voice: ${voice}, speed: ${speed}`);
  const { angle, subject, focus, scenes } = await generateScript(runConfig);

  const fullText = scenes.map((s) => s.narration).join(" ");
  const wordCount = fullText.split(/\s+/).filter(Boolean).length;
  const date = new Date().toISOString().slice(0, 10);

  const outDir = path.join(__dirname, "output");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outFile = path.join(outDir, `${date}-script.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        date,
        niche: niche.id,
        format: format.id,
        voice,
        speed,
        angle,
        subject,
        focus,
        scenes,
      },
      null,
      2
    )
  );

  const readableFile = path.join(outDir, `${date}-script.txt`);
  fs.writeFileSync(readableFile, fullText);

  saveHistory({
    date,
    niche: niche.id,
    format: format.id,
    angle,
    subject,
    focus,
    wordCount,
    sceneCount: scenes.length,
    file: outFile,
  });

  console.log(`${niche.subjectNoun[0].toUpperCase()}${niche.subjectNoun.slice(1)}: ${subject} (${focus})`);
  console.log(`Angle: ${angle || "(custom niche — no fixed angle)"}`);
  console.log(`Scenes: ${scenes.length}`);
  console.log(`Word count: ${wordCount} (~${Math.round(wordCount / 150)} min spoken)`);
  console.log(`Saved to: ${outFile}`);
  console.log("\n--- SCRIPT ---\n");
  scenes.forEach((s, i) => {
    console.log(`[Scene ${i + 1}] ${s.narration}`);
    console.log(`  image: ${s.imagePrompt}\n`);
  });
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});




