# สรุป (Saroop Local)

Privacy-first Thai meeting transcription and reporting that runs entirely in the browser.

## Architecture

- Thai speech-to-text: multilingual Whisper Small via Transformers.js + WebGPU, isolated in a Web Worker.
- Report generation: Gemma 4 E2B via the early-preview LiteRT-LM Web API.
- Audio, transcript, and report stay in browser memory. There are no API routes, analytics, accounts, or uploads.
- Model weights are downloaded from Hugging Face on first use and cached by the browser.
- Audio selection reads metadata only. The file is decoded once when processing starts, mixed to mono at 16 kHz, and transferred to the transcription worker.
- File duration limits adapt to the browser's reported device memory (30–120 minutes) with a 250 MB compressed-file ceiling.
- Long transcripts are reduced sequentially in bounded recursive passes before final report synthesis.
- Gemma output is schema-validated and receives one constrained JSON-repair attempt before a recoverable error is shown.

> LiteRT-LM's current Web API is text-in/text-out only. Its native runtimes support audio, but the browser runtime does not yet expose audio input. Whisper is therefore the local ASR layer while Gemma produces the report.

## Development

```bash
npm install
npm run dev
```

Use a recent Chrome or Edge build with WebGPU. The initial model downloads are large and can take several minutes.

## Validation

```bash
npm test
npm run lint
npm run build
```

The browser pipeline was also validated locally with a one-minute segment from a real Thai meeting recording: Whisper completed transcription, Gemma initialized with WebGPU, and a schema-valid report rendered successfully. Accuracy still depends on recording clarity, overlapping speakers, and the Whisper Small model's Thai-language capability.

## Deploy to Vercel

Import the repository into Vercel. `vercel.json` already configures the Vite build and cross-origin isolation headers needed by browser ML runtimes.
