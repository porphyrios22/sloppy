// Kokoro is a fixed-voicepack model (no cloning) — this is the curated list
// of voice IDs worth offering in the UI, graded roughly best-to-generic per
// gender the way generateAudio.js used to document only in a comment.
const VOICES = [
  { id: "am_michael", label: "Michael — warm & trustworthy (default)", gender: "male" },
  { id: "am_fenrir", label: "Fenrir — deep & powerful", gender: "male" },
  { id: "am_puck", label: "Puck — playful & energetic", gender: "male" },
  { id: "am_adam", label: "Adam — generic male", gender: "male" },
  { id: "af_heart", label: "Heart — warm female", gender: "female" },
  { id: "af_bella", label: "Bella — confident female", gender: "female" },
  { id: "af_sarah", label: "Sarah — calm female", gender: "female" },
];

const DEFAULT_VOICE = "am_michael";
const DEFAULT_SPEED = 1.0;
const MIN_SPEED = 0.75;
const MAX_SPEED = 1.3;

module.exports = { VOICES, DEFAULT_VOICE, DEFAULT_SPEED, MIN_SPEED, MAX_SPEED };