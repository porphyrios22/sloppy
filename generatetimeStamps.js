const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { pipeline } = require("@huggingface/transformers");

const OUTPUT_DIR = path.join(__dirname, "output");
const WHISPER_MODEL = "onnx-community/whisper-tiny.en_timestamped"; // regular whisper-tiny.en ONNX exports lack cross-attention data needed for word timestamps — this variant is built specifically for it

function getLatestAudio() {
  const files = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith("-audio.wav"))
    .map((f) => ({ name: f, time: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);

  if (!files.length) {
    throw new Error("No audio file found in output/. Run generateAudio.js first.");
  }
  return path.join(OUTPUT_DIR, files[0].name);
}

// Kokoro outputs 24kHz audio; Whisper expects 16kHz. ffmpeg handles the resample.
function resampleTo16kMono(inputPath) {
  const outputPath = inputPath.replace("-audio.wav", "-audio-16k.wav");
  try {
    execFileSync(
      "ffmpeg",
      ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", outputPath],
      { stdio: "pipe" }
    );
  } catch (err) {
    throw new Error(
      "ffmpeg failed — make sure ffmpeg is installed and on your PATH.\n" +
        "Windows: download the 'essentials' build from https://www.gyan.dev/ffmpeg/builds/, " +
        "unzip it, and add the bin folder to your System PATH (then restart your terminal).\n" +
        (err.stderr ? err.stderr.toString() : err.message)
    );
  }
  return outputPath;
}

// Minimal WAV parser — walks chunks properly rather than assuming a fixed
// 44-byte header, so it works even if ffmpeg adds extra metadata chunks.
function readWavPCM16Mono(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a valid WAV file: " + filePath);
  }

  let offset = 12;
  let sampleRate = null;
  let dataOffset = null;
  let dataSize = null;
  let bitsPerSample = null;
  let numChannels = null;

  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === "fmt ") {
      numChannels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    } else if (chunkId === "data") {
      dataOffset = offset + 8;
      dataSize = chunkSize;
    }

    offset += 8 + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }

  if (dataOffset === null) throw new Error("No data chunk found in WAV: " + filePath);
  if (bitsPerSample !== 16) throw new Error(`Expected 16-bit PCM, got ${bitsPerSample}-bit`);

  const numSamples = Math.floor(dataSize / 2 / numChannels);
  const float32 = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const sampleOffset = dataOffset + i * numChannels * 2;
    float32[i] = buffer.readInt16LE(sampleOffset) / 32768;
  }

  return { samples: float32, sampleRate };
}

async function main() {
  const audioPath = getLatestAudio();
  console.log(`Using audio: ${path.basename(audioPath)}`);

  console.log("Resampling to 16kHz mono for Whisper...");
  const resampledPath = resampleTo16kMono(audioPath);

  const { samples, sampleRate } = readWavPCM16Mono(resampledPath);
  console.log(`Loaded ${samples.length} samples at ${sampleRate}Hz`);

  console.log(`Loading Whisper model (${WHISPER_MODEL})... this can take a minute on first run.`);
  const transcriber = await pipeline("automatic-speech-recognition", WHISPER_MODEL, {
    dtype: "q8",
  });

  console.log("Transcribing with word-level timestamps...");
  const result = await transcriber(samples, {
    return_timestamps: "word",
    chunk_length_s: 30,
    stride_length_s: 5,
  });

  const words = (result.chunks || []).map((c) => ({
    word: c.text.trim(),
    start: c.timestamp[0],
    end: c.timestamp[1],
  }));

  const outPath = audioPath.replace("-audio.wav", "-timestamps.json");
  fs.writeFileSync(outPath, JSON.stringify({ fullText: result.text, words }, null, 2));

  fs.unlinkSync(resampledPath); // clean up the temporary 16kHz file

  console.log(`Saved ${words.length} word timestamps to: ${outPath}`);
}

main().catch((err) => {
  console.error("Timestamp generation failed:", err.message);
  process.exit(1);
});