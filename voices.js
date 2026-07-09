// ElevenLabs premade voices — curated list worth offering in the UI,
// same shape as the old Kokoro voices.js so the dashboard dropdown and
// anything else importing this file doesn't need to change.
//
// IMPORTANT: These are classic ElevenLabs "Default voice" IDs. ElevenLabs
// is retiring Default voices — they expire Dec 31, 2026, and are only
// selectable for accounts created before March 2026. If your ElevenLabs
// account is newer than that, some/all of these IDs may not resolve for
// you at all. Before trusting this list, run a quick check against your
// own account:
//
//   curl -s https://api.elevenlabs.io/v1/voices \
//     -H "xi-api-key: $ELEVENLABS_API_KEY" | jq '.voices[] | {name, voice_id}'
//
// and swap in whatever voice_ids actually show up (My Voices > Default
// filter, or anything from the Voice Library you've added). The safest
// long-term fix is to fetch live from that endpoint instead of hardcoding,
// see fetchVoicesFromAccount() at the bottom — optional, not wired in by
// default so this stays a drop-in replacement.

const VOICES = [
  { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel — warm & trustworthy (default)", gender: "female" },
  { id: "pNInz6obpgDQGcFmaJgB", label: "Adam — deep & confident", gender: "male" },
  { id: "TxGEqnHWrfWFTfGW9XjX", label: "Josh — deep & narrative", gender: "male" },
  { id: "VR6AewLTigWG4xSOukaG", label: "Arnold — crisp & authoritative", gender: "male" },
  { id: "ErXwobaYiN019PkySvjV", label: "Antoni — smooth & well-rounded", gender: "male" },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Bella — confident female", gender: "female" },
  { id: "MF3mGyEYCl7XYWbV9V6O", label: "Elli — bright & youthful", gender: "female" },
];

// Must match ELEVENLABS_VOICE_ID default in tts.js (Rachel) so the two
// stay in sync if you change one.
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";
const DEFAULT_SPEED = 1.0;

// ElevenLabs hard-rejects speed values outside 0.7-1.2 (confirmed in
// their docs as of mid-2026) — this replaces Kokoro's looser 0.75-1.3.
const MIN_SPEED = 0.7;
const MAX_SPEED = 1.2;

// Optional: pull the live, actually-available voices for your account
// instead of relying on the hardcoded list above. Handy to run once and
// diff against VOICES, or to wire into the dashboard directly.
async function fetchVoicesFromAccount(apiKey) {
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs /v1/voices error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.voices.map((v) => ({
    id: v.voice_id,
    label: v.name,
    gender: v.labels?.gender || "unknown",
  }));
}

module.exports = {
  VOICES,
  DEFAULT_VOICE,
  DEFAULT_SPEED,
  MIN_SPEED,
  MAX_SPEED,
  fetchVoicesFromAccount,
};