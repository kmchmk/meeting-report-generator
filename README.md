# สรุป (Saroop Local)

Thai meeting transcription and reporting with a privacy-first offline mode that runs entirely in the browser. An optional Groq cloud mode is present but disabled by default.

## Architecture

- **Engine selector**: local processing is always available; when cloud processing is explicitly enabled at build and runtime, Groq is the recommended default.
- **Offline mode** (default)
  - Thai speech-to-text: multilingual Whisper Small (about 590 MB) / Large V3 Turbo (about 1.95 GB) via Transformers.js + WebGPU, isolated in a Web Worker.
  - Report generation: Gemma 4 E2B (about 1.87 GiB) via the early-preview LiteRT-LM Web API. Interrupted downloads resume with byte ranges and successful downloads are committed to browser cache before WebGPU setup.
  - Audio, transcript, and report stay in browser memory. Model weights are downloaded from Hugging Face on first use and cached by the browser.
- **Cloud mode** (Groq free tier)
  - Speech-to-text: Whisper Large V3 via `api/transcribe.ts` (audio is decoded locally, converted to mono 16 kHz WAV, and uploaded in ~100-second chunks).
  - Report generation: GPT-OSS 120B via `api/report.ts`, which streams NDJSON progress events while reducing long transcripts sequentially in bounded passes before final synthesis.
  - Both endpoints are thin proxies; the Groq API key never reaches the browser. Reports are schema-validated server-side and again on the client.
  - Each selected recording requires explicit upload consent. Temporary free-tier rate limits are retried using Groq's `Retry-After` guidance.
- Shared reduction/validation logic lives in `api/_lib/report-core.ts` and is used identically by both engines (kept inside `api/` so serverless bundles always include it).
- Long transcripts are reduced sequentially before final report synthesis; output receives one constrained JSON-repair attempt before a recoverable error is shown.
- Audio selection reads metadata only. The file is decoded once when processing starts, mixed to mono at 16 kHz, then either transferred to the transcription worker or chunked for upload.

> Cloud mode sends audio and transcripts to Groq's servers. For confidential meetings use offline mode. Groq's free tier has rate limits (requests/minute and audio seconds/day), so concurrent or back-to-back runs may need to wait. Protect a public deployment with Vercel Deployment Protection or an equivalent authentication layer so strangers cannot consume your quota.

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
npx vercel env add ENABLE_CLOUD_MODE       # true (server runtime gate)
npx vercel env add VITE_ENABLE_CLOUD_MODE  # true (build-time UI gate)
npx vercel dev                    # serves the Vite app + api/ routes together
```

Get a free API key at https://console.groq.com. Never commit `.env.local` or real keys.

## Validation

```bash
npm test
npm run lint
npm run build
```

The browser pipeline was validated locally with a one-minute segment using both Whisper choices and with a full 26:44 Thai M4A using Whisper Small. The full run completed 80 ASR chunks, produced 255 timestamped transcript rows, reduced the long transcript in three bounded sections, and rendered a schema-valid report. A fresh-page rerun found the 1.87 GiB Gemma file in browser cache and skipped the network download. Accuracy still depends on recording clarity, overlapping speakers, and the ASR model's Thai-language capability.

## Deploy to Vercel

Import the repository into Vercel; offline mode works without any environment variables. To opt into cloud mode, set `GROQ_API_KEY`, `ENABLE_CLOUD_MODE=true`, and `VITE_ENABLE_CLOUD_MODE=true` (Project → Settings → Environment Variables), then redeploy. The cloud endpoints consume your Groq quota, so add authentication or platform-level rate limiting before exposing them to an untrusted public audience. `vercel.json` configures the Vite build, function durations (`api/report.ts` needs up to 300 s — enable Fluid compute on Hobby), and the cross-origin isolation headers needed by browser ML runtimes.
