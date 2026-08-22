# สรุป (Saroop Local)

Thai meeting transcription and reporting with two interchangeable engines: a privacy-first offline mode that runs entirely in the browser, and a free cloud mode powered by Groq.

## Architecture

- **Engine selector**: pick per run between local (offline) and cloud (Groq) processing.
- **Offline mode** (default)
  - Thai speech-to-text: multilingual Whisper Small / Large V3 Turbo via Transformers.js + WebGPU, isolated in a Web Worker.
  - Report generation: Gemma 4 E2B via the early-preview LiteRT-LM Web API.
  - Audio, transcript, and report stay in browser memory. Model weights are downloaded from Hugging Face on first use and cached by the browser.
- **Cloud mode** (Groq free tier)
  - Speech-to-text: Whisper Large V3 via `api/transcribe.ts` (audio is decoded locally, converted to mono 16 kHz WAV, and uploaded in ~100-second chunks).
  - Report generation: Llama 3.3 70B via `api/report.ts`, which streams NDJSON progress events while reducing long transcripts sequentially in bounded passes before final synthesis.
  - Both endpoints are thin proxies; the Groq API key never reaches the browser. Reports are schema-validated server-side and again on the client.
- Shared reduction/validation logic lives in `src/lib/report-core.ts` and is used identically by both engines.
- Long transcripts are reduced sequentially before final report synthesis; output receives one constrained JSON-repair attempt before a recoverable error is shown.
- Audio selection reads metadata only. The file is decoded once when processing starts, mixed to mono at 16 kHz, then either transferred to the transcription worker or chunked for upload.

> Cloud mode sends audio and transcripts to Groq's servers. For confidential meetings use offline mode. Groq's free tier has rate limits (requests/minute and audio seconds/day), so concurrent or back-to-back runs may need to wait.

## Development

```bash
npm install
npm run dev
```

Offline mode works directly under `npm run dev`. Use a recent Chrome or Edge build with WebGPU; initial model downloads are large and can take several minutes.

To exercise cloud mode locally you need the Vercel functions:

```bash
npx vercel login
npx vercel link
npx vercel env add GROQ_API_KEY   # paste a key from https://console.groq.com
npx vercel dev                    # serves the Vite app + api/ routes together
```

Get a free API key at https://console.groq.com. Never commit `.env.local` or real keys.

## Validation

```bash
npm test
npm run lint
npm run build
```

The browser pipeline was validated locally with a one-minute segment from a real Thai meeting recording: Whisper completed transcription, Gemma initialized with WebGPU, and a schema-valid report rendered successfully. Accuracy still depends on recording clarity, overlapping speakers, and the ASR model's Thai-language capability.

## Deploy to Vercel

Import the repository into Vercel and set the `GROQ_API_KEY` environment variable (Project → Settings → Environment Variables) to enable cloud mode; offline mode works without any configuration. `vercel.json` configures the Vite build, function durations (`api/report.ts` needs up to 300 s — enable Fluid compute on Hobby), and the cross-origin isolation headers needed by browser ML runtimes.
