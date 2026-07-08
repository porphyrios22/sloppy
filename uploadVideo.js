require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { google } = require("googleapis");

const CREDENTIALS_PATH = path.join(__dirname, "client_secret.json");
const TOKEN_PATH = path.join(__dirname, "youtube-token.json");
const OUTPUT_DIR = path.join(__dirname, "output");

// Google forces every upload from an unverified API project to "private"
// regardless of this setting — see the project notes. Set explicitly anyway,
// both for clarity and for if/when this project ever goes through Google's
// audit process to unlock public uploads via the API.
const PRIVACY_STATUS = process.env.YOUTUBE_PRIVACY || "private";

function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Missing ${CREDENTIALS_PATH} — see README for setup.`);
  }
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  return raw.installed || raw.web;
}

function loadTokens() {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(`Missing ${TOKEN_PATH} — run "node authorizeYoutube.js" once first (one-time browser login).`);
  }
  return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
}

function getLatestByExt(suffix) {
  const files = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith(suffix))
    .map((f) => ({ name: f, time: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);

  if (!files.length) {
    throw new Error(`No file ending in "${suffix}" found in output/.`);
  }
  return path.join(OUTPUT_DIR, files[0].name);
}

// Per-niche title framing and base hashtags. Falls back to a generic phrase
// for niches not listed here (e.g. a freshly added niche, or "custom").
const TITLE_SUFFIX_BY_NICHE = {
  "anime-superhero": "— Lore You Didn't Know",
  "movie-tv-trivia": "— Trivia You Didn't Know",
  "science-space": "— The Science Behind It",
  "space-facts-updates": "— What You Should Know",
  "true-crime": "— The Full Story",
  "horror-stories": "",
  "mind-twist-trivia": "— You Won't See This Coming",
};
const HASHTAGS_BY_NICHE = {
  "anime-superhero": ["anime", "lore"],
  "movie-tv-trivia": ["movies", "tvtrivia"],
  "science-space": ["science", "space"],
  "space-facts-updates": ["space", "nasa"],
  "true-crime": ["truecrime", "mystery"],
  "horror-stories": ["horror", "creepypasta"],
  "mind-twist-trivia": ["trivia", "mindblown"],
  custom: ["shorts"],
};

function buildMetadata(scriptPath) {
  const script = JSON.parse(fs.readFileSync(scriptPath, "utf-8"));

  // subject/focus are the current field names (generateScript.js v2+).
  // franchise/characterFocus is the old naming — keep reading it so scripts
  // generated before this update still upload with sensible metadata.
  const subject = script.subject || script.franchise || "This video";
  const focus = script.focus || script.characterFocus || "";
  const nicheId = script.niche || "anime-superhero";
  const isShort = script.format === "short";
  const fullNarration = (script.scenes || []).map((s) => s.narration).join(" ");

  const suffix = TITLE_SUFFIX_BY_NICHE[nicheId] ?? "— You Won't Believe This";
  let title = `${subject}${focus ? ": " + focus : ""}${suffix ? " " + suffix : ""}`.trim();
  if (isShort) {
    // #Shorts needs to appear in the title or description for YouTube to
    // treat it as a Short — put it in the title, trimming the rest to fit.
    const shortsTag = " #Shorts";
    title = title.slice(0, 100 - shortsTag.length) + shortsTag;
  } else {
    title = title.slice(0, 100);
  }

  const baseHashtags = HASHTAGS_BY_NICHE[nicheId] || ["shorts"];
  const hashtags = [...baseHashtags, subject.replace(/[^a-zA-Z0-9]/g, ""), isShort ? "Shorts" : null]
    .filter(Boolean)
    .map((t) => `#${t}`)
    // de-dupe in case e.g. "shorts" already in baseHashtags and we added "Shorts" again
    .filter((t, i, arr) => arr.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i)
    .join(" ");

  const description = `${fullNarration.slice(0, 4500)}\n\n${hashtags}`;

  const tags = [subject, focus, ...baseHashtags].filter(Boolean);

  return { title, description, tags };
}

function getMediaFolder(baseName) {
  return path.join(OUTPUT_DIR, `${baseName}-media`);
}

// Picks a thumbnail from your own dropped-in media. If the first item is a
// video clip, grabs a frame 1s in (ffmpeg) rather than trying to set a video
// file directly as a thumbnail. Override the source file with
// THUMBNAIL_SOURCE_FILE in .env (a filename inside the media folder).
function getThumbnailImage(baseName) {
  const mediaFolder = getMediaFolder(baseName);
  if (!fs.existsSync(mediaFolder)) {
    console.warn(`  No media folder at ${mediaFolder} — skipping custom thumbnail.`);
    return null;
  }

  const files = fs.readdirSync(mediaFolder).sort();
  const chosen = process.env.THUMBNAIL_SOURCE_FILE || files[0];
  if (!chosen) {
    console.warn(`  Media folder is empty — skipping custom thumbnail.`);
    return null;
  }

  const sourcePath = path.join(mediaFolder, chosen);
  const ext = path.extname(chosen).toLowerCase();
  const isVideo = [".mp4", ".mov", ".m4v", ".webm", ".mkv"].includes(ext);

  if (!isVideo) return sourcePath; // already an image, use directly

  const framePath = path.join(OUTPUT_DIR, `${baseName}-thumbnail.jpg`);
  try {
    execFileSync("ffmpeg", ["-y", "-ss", "1", "-i", sourcePath, "-frames:v", "1", framePath], { stdio: "ignore" });
    return framePath;
  } catch (err) {
    console.warn(`  Couldn't extract a thumbnail frame from ${chosen} — skipping custom thumbnail.`);
    return null;
  }
}

async function setThumbnail(youtube, videoId, imagePath) {
  try {
    await youtube.thumbnails.set({
      videoId,
      media: { body: fs.createReadStream(imagePath) },
    });
    console.log(`Thumbnail set from: ${path.basename(imagePath)}`);
  } catch (err) {
    const message = err.response?.data?.error?.message || err.message;
    if (/verif/i.test(message)) {
      console.warn(
        "\nCouldn't set a custom thumbnail — your channel needs phone verification first.\n" +
          "Go to youtube.com/verify, verify your number, wait ~24h, then re-run this script " +
          "(or run just the thumbnail step once that's done). The video itself uploaded fine either way."
      );
    } else {
      console.warn(`Thumbnail upload failed (video still uploaded fine): ${message}`);
    }
  }
}

async function uploadCaptions(youtube, videoId, srtPath) {
  try {
    await youtube.captions.insert({
      part: ["snippet"],
      requestBody: {
        snippet: {
          videoId,
          language: "en",
          name: "English",
          isDraft: false,
        },
      },
      media: {
        mimeType: "application/octet-stream",
        body: fs.createReadStream(srtPath),
      },
    });
    console.log(`Captions uploaded from: ${path.basename(srtPath)} (toggleable in the video's CC menu, not burned in)`);
  } catch (err) {
    const message = err.response?.data?.error?.message || err.message;
    console.warn(`Caption upload failed (video still uploaded fine): ${message}`);
  }
}

async function main() {
  const creds = loadCredentials();
  const tokens = loadTokens();

  const oauth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret);
  oauth2Client.setCredentials(tokens);

  const youtube = google.youtube({ version: "v3", auth: oauth2Client });

  const videoPath = getLatestByExt("-final.mp4");
  const scriptPath = getLatestByExt("-script.json");
  const { title, description, tags } = buildMetadata(scriptPath);

  console.log(`Uploading: ${path.basename(videoPath)}`);
  console.log(`Title: ${title}`);
  console.log(`Privacy: ${PRIVACY_STATUS}`);

  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title,
        description,
        tags,
        categoryId: "1", // Film & Animation
      },
      status: {
        privacyStatus: PRIVACY_STATUS,
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: fs.createReadStream(videoPath),
    },
  });

  console.log(`\nUploaded. Video ID: ${res.data.id}`);
  console.log(`Link (only visible to you until you flip it to public/unlisted in YouTube Studio): https://youtu.be/${res.data.id}`);

  const baseName = path.basename(videoPath, "-final.mp4");

  fs.writeFileSync(
    path.join(OUTPUT_DIR, `${baseName}-youtube.json`),
    JSON.stringify(
      { videoId: res.data.id, url: `https://youtu.be/${res.data.id}`, uploadedAt: new Date().toISOString(), privacyStatus: PRIVACY_STATUS },
      null,
      2
    )
  );

  const thumbnailImage = getThumbnailImage(baseName);
  if (thumbnailImage) {
    await setThumbnail(youtube, res.data.id, thumbnailImage);
  }

  const srtPath = path.join(OUTPUT_DIR, `${baseName}-subtitles.srt`);
  if (fs.existsSync(srtPath)) {
    await uploadCaptions(youtube, res.data.id, srtPath);
  } else {
    console.warn(`No subtitles file at ${srtPath} — skipping caption upload.`);
  }
}

main().catch((err) => {
  console.error("Upload failed:", err.response?.data?.error?.message || err.message);
  process.exit(1);
});