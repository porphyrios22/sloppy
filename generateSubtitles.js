const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "output");

const MAX_WORDS_PER_CUE = 7; // readable chunk size for a bottom subtitle bar
const MAX_CHARS_PER_CUE = 42; // roughly one line at standard subtitle font sizes
const MAX_CUE_DURATION = 4.0; // seconds — don't let a cue linger too long even if words are short

function getLatestTimestamps() {
  const files = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith("-timestamps.json"))
    .map((f) => ({ name: f, time: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);

  if (!files.length) {
    throw new Error("No timestamps file found in output/. Run generatetimeStamps.js first.");
  }
  return path.join(OUTPUT_DIR, files[0].name);
}

function formatSrtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msRem = ms % 1000;
  const pad = (n, len) => String(n).padStart(len, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(msRem, 3)}`;
}

// Groups words into readable cues, breaking on sentence-ending punctuation,
// word count, character count, or duration — whichever comes first.
function groupWordsIntoCues(words) {
  const cues = [];
  let current = [];

  const flush = () => {
    if (!current.length) return;
    const text = current.map((w) => w.word).join(" ").replace(/\s+([,.!?;:])/g, "$1");
    cues.push({
      start: current[0].start,
      end: current[current.length - 1].end,
      text,
    });
    current = [];
  };

  for (const word of words) {
    current.push(word);

    const text = current.map((w) => w.word).join(" ");
    const duration = current[current.length - 1].end - current[0].start;
    const endsSentence = /[.!?]$/.test(word.word);

    const shouldFlush =
      current.length >= MAX_WORDS_PER_CUE ||
      text.length >= MAX_CHARS_PER_CUE ||
      duration >= MAX_CUE_DURATION ||
      endsSentence;

    if (shouldFlush) flush();
  }
  flush(); // trailing partial cue

  return cues;
}

function buildSrt(cues) {
  return cues
    .map((cue, i) => `${i + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text}\n`)
    .join("\n");
}

function main() {
  const timestampsPath = getLatestTimestamps();
  console.log(`Using timestamps: ${path.basename(timestampsPath)}`);

  const { words } = JSON.parse(fs.readFileSync(timestampsPath, "utf-8"));
  if (!Array.isArray(words) || !words.length) {
    throw new Error(`No words found in ${timestampsPath}`);
  }

  const cues = groupWordsIntoCues(words);
  const srt = buildSrt(cues);

  const outPath = timestampsPath.replace("-timestamps.json", "-subtitles.srt");
  fs.writeFileSync(outPath, srt, "utf-8");

  console.log(`Built ${cues.length} subtitle cues from ${words.length} words.`);
  console.log(`Saved: ${outPath}`);
}

main();
