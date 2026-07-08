const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const OUTPUT_DIR = path.join(__dirname, "output");
const FPS = 25;

// Shorts get a vertical 9:16 frame; long-form stays the usual 16:9. Read off
// the script.json's "format" field (set by the niche/format picker in the
// dashboard when the script was generated) so this adapts automatically —
// no separate flag to remember to pass at the video stage.
const DIMENSIONS = {
  long: { width: 1920, height: 1080 },
  short: { width: 1080, height: 1920 },
};

// How long a still image stays on screen before cutting to the next item.
// Shorts default to quicker cuts to match their faster pacing.
function getImageDuration(format) {
  if (process.env.MEDIA_IMAGE_DURATION) return parseFloat(process.env.MEDIA_IMAGE_DURATION);
  return format === "short" ? 2.0 : 4.0;
}
// Cap on how much of any single video clip gets used per appearance, so one
// long clip can't eat a huge chunk of the video. Trimmed from the start.
const VIDEO_MAX_DURATION = process.env.MEDIA_VIDEO_MAX_DURATION ? parseFloat(process.env.MEDIA_VIDEO_MAX_DURATION) : 8.0;

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);

function getLatestScriptInfo() {
  const files = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith("-script.json"))
    .map((f) => ({ name: f, time: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);

  if (!files.length) throw new Error("No script found in output/. Run the earlier stages first.");

  const stem = files[0].name.replace("-script.json", "");
  let format = "long";
  try {
    const script = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, files[0].name), "utf-8"));
    format = script.format === "short" ? "short" : "long";
  } catch (err) {
    console.warn(`Warning: couldn't read format from ${files[0].name} (${err.message}) — defaulting to long-form.`);
  }
  return { stem, format };
}

function ffprobeDuration(filePath) {
  const out = execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  return parseFloat(out.toString().trim());
}

// Reads whatever images/clips are sitting in the media folder, in filename
// order (so name them 01, 02, 03... to control the sequence), tags each with
// its type, and — for videos — its native duration.
function loadMediaPool(mediaDir) {
  const files = fs
    .readdirSync(mediaDir)
    .filter((f) => {
      const ext = path.extname(f).toLowerCase();
      return IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext);
    })
    .sort(); // filename order — e.g. 01.mp4, 02.jpg, 03.mp4...

  if (!files.length) {
    throw new Error(
      `No images or video clips found in ${mediaDir}. Drop some in (named so alphabetical order = playback order, e.g. 01.mp4, 02.jpg...) and re-run.`
    );
  }

  return files.map((f) => {
    const filePath = path.join(mediaDir, f);
    const ext = path.extname(f).toLowerCase();
    const isVideo = VIDEO_EXTENSIONS.has(ext);
    const nativeDuration = isVideo ? ffprobeDuration(filePath) : null;
    return { path: filePath, isVideo, nativeDuration };
  });
}

// Cycles through the media pool (looping back to the start if the narration
// is longer than one pass through your clips) until the cumulative duration
// reaches the narration's exact length, trimming the final clip so the
// total lands exactly on target — no gaps, no dead air at the end.
function buildPlaylist(mediaPool, totalAudioDuration, imageDuration) {
  const playlist = [];
  let cumulative = 0;
  let poolIndex = 0;

  while (cumulative < totalAudioDuration) {
    const item = mediaPool[poolIndex % mediaPool.length];
    const naturalDuration = item.isVideo ? Math.min(item.nativeDuration, VIDEO_MAX_DURATION) : imageDuration;

    let duration = naturalDuration;
    if (cumulative + duration > totalAudioDuration) {
      duration = totalAudioDuration - cumulative; // trim the final clip to land exactly on target
    }

    playlist.push({ ...item, duration });
    cumulative += duration;
    poolIndex++;

    // Safety valve: if durations are somehow all ~0, don't spin forever.
    if (playlist.length > 500) break;
  }

  return mergeConsecutiveSameFile(playlist);
}

// When the media pool is small relative to the narration's length (e.g. one
// video clip for a 4-minute video), the loop above naturally repeats that
// same file many times in a row. Left as separate playlist entries, each
// repeat becomes its OWN ffmpeg input (-stream_loop -1 -t 8 -i clip.mp4),
// so ffmpeg ends up holding many simultaneous decoder streams open for the
// exact same file — with one clip covering a 228s narration in 8s chunks,
// that's ~29 duplicate decoders alive at once, which is enough to exhaust
// memory on an 8GB machine and get the process killed outright (no clean
// ffmpeg error, just a dead process). A continuous loop of ONE file is
// exactly equivalent playback-wise to concatenating many copies of itself
// back-to-back, so merge consecutive same-file entries into a single
// longer input instead — one decoder stream, however long it needs to run.
function mergeConsecutiveSameFile(playlist) {
  const merged = [];
  for (const item of playlist) {
    const prev = merged[merged.length - 1];
    if (prev && prev.path === item.path) {
      prev.duration += item.duration;
    } else {
      merged.push({ ...item });
    }
  }
  return merged;
}

// Straight cuts only — no Ken Burns pan/zoom, no crossfade transitions.
// Each item is scaled/cropped to fill the frame, then hard-concatenated.
function buildFilterComplex(playlist, width, height) {
  const filters = [];
  const labels = [];

  playlist.forEach((item, i) => {
    filters.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${FPS}[v${i}]`
    );
    labels.push(`[v${i}]`);
  });

  filters.push(`${labels.join("")}concat=n=${playlist.length}:v=1:a=0[outv]`);

  return filters.join(";\n");
}

function assembleVideo({ playlist, audioPath, outputPath, width, height }) {
  const filterComplex = buildFilterComplex(playlist, width, height);

  const inputArgs = [];
  playlist.forEach((item) => {
    if (item.isVideo) {
      // -stream_loop -1 lets a clip shorter than its assigned duration wrap
      // back to its own start rather than running out of frames.
      inputArgs.push("-stream_loop", "-1", "-t", item.duration.toFixed(3), "-i", item.path);
    } else {
      inputArgs.push("-loop", "1", "-framerate", String(FPS), "-t", item.duration.toFixed(3), "-i", item.path);
    }
  });

  const audioInputIndex = playlist.length;

  const args = [
    "-y",
    ...inputArgs,
    "-i", audioPath,
    "-filter_complex", filterComplex,
    "-map", "[outv]",
    "-map", `${audioInputIndex}:a`,
    "-r", String(FPS),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    outputPath,
  ];

  execFileSync("ffmpeg", args, { stdio: "inherit" });
}

function main() {
  const { stem, format } = getLatestScriptInfo();
  const { width, height } = DIMENSIONS[format];
  const imageDuration = getImageDuration(format);

  const audioPath = path.join(OUTPUT_DIR, `${stem}-audio.wav`);
  const mediaDir = path.join(OUTPUT_DIR, `${stem}-media`);

  if (!fs.existsSync(audioPath)) {
    throw new Error(`Missing required file: ${audioPath}\nRun the earlier stages first (script, audio).`);
  }
  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
    throw new Error(
      `Created ${mediaDir} — drop your images/video clips in there (named so alphabetical order = playback order, e.g. 01.mp4, 02.jpg...), then re-run.`
    );
  }

  console.log(`Format: ${format} (${width}x${height})`);
  console.log("Reading audio duration...");
  const totalAudioDuration = ffprobeDuration(audioPath);
  console.log(`Audio duration: ${totalAudioDuration.toFixed(2)}s`);

  console.log(`Reading media from: ${mediaDir}`);
  const mediaPool = loadMediaPool(mediaDir);
  console.log(`Found ${mediaPool.length} clip(s)/image(s): ${mediaPool.map((m) => path.basename(m.path)).join(", ")}`);

  const playlist = buildPlaylist(mediaPool, totalAudioDuration, imageDuration);
  playlist.forEach((item, i) =>
    console.log(`  ${i + 1}. ${path.basename(item.path)} (${item.isVideo ? "video" : "image"}) — ${item.duration.toFixed(2)}s`)
  );

  const outputPath = path.join(OUTPUT_DIR, `${stem}-final.mp4`);
  console.log("Assembling video (this can take a minute)...");
  assembleVideo({ playlist, audioPath, outputPath, width, height });

  console.log(`\nDone. Saved: ${outputPath}`);
  console.log("Note: captions aren't burned in — the .srt from generateSubtitles.js gets uploaded as a separate toggleable caption track during upload.");
}

main();