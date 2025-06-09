# Async Audio OpenAI

`@silyze/async-audio-openai` is a **full‑duplex wrapper** around the \
[OpenAI Realtime API](https://platform.openai.com/docs/assistants/overview#realtime-beta) \
built on **`@silyze/async-audio-stream`**.  
It streams **µ‑law (G.711) audio** to the `/v1/realtime` WebSocket endpoint, \
receives delta/response frames, and exposes them through the familiar \
`AudioStream` interface – so you can plug it straight into the rest of the \
`@silyze/*` async‑stream ecosystem.

- ✔️ 8 kHz µ‑law audio codec via `@silyze/async-audio-format-ulaw`
- ✔️ Real‑time speech transcripts (`transcript` stream)
- ✔️ `writeMessage()` helper for sending text prompts
- ✔️ Bridging **OpenAI Function Calls** with \
  [`@silyze/async-openai-function-stream`](https://www.npmjs.com/package/@silyze/async-openai-function-stream)
- ✔️ DTMF helper for telephony integrations
- ✔️ Abort‑signal aware and back‑pressure friendly

---

## Install

```bash
npm install @silyze/async-audio-openai \
            @silyze/async-openai-function-stream  # ← if you need function calls
```

> Requires Node ≥ 18 and the **[WS](https://www.npmjs.com/package/ws)** polyfill \
> (`peerDependency`) when used outside browsers.

---

## Quick Start

```ts
import OpenAiStream, {
  OpenAiVoice,
  OpenAiSessionConfig,
} from "@silyze/async-audio-openai";
import { OpusFormat } from "@silyze/async-audio-format-webm";

const key = process.env.OPENAI_API_KEY!;
const voice: OpenAiVoice = "alloy";

const session: OpenAiSessionConfig = {
  voice,
  model: "gpt-4o-audio-preview",
  instructions: "You are a helpful voice assistant.",
};

// 1.  Create the realtime connection & audio stream.
const { stream, socket } = await OpenAiStream.create(key, session, []);

// 2.  Capture microphone in µ‑law and pipe to OpenAI.
getMicrophoneStream().pipe(stream);

// 3.  Handle transcript lines.
stream.transcript.forEach((line) => {
  console.log(`[${line.source}] ${line.content}`);
});
```

---

## OpenAI Function Calls

Combine `OpenAiStream` with **`@silyze/async-openai-function-stream`** to \
transparently proxy function calls:

```ts
import {
  createJsonStreamFunctions,
  FunctionStream,
} from "@silyze/async-openai-function-stream";

// Expose local functions to the AI
const { tools, collection } = createJsonStreamFunctions(
  [
    {
      type: "function",
      name: "get_time",
      description: "Return the current ISO date/time.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  ],
  wire.reverse()
);

const wire = new FunctionStream(collection); // JSON ⬅️➡️  OpenAI frames
wire.pipe(stream);

// Tell OpenAI about them:
await stream.update(session, tools);

// Later – handle calls:
wire.forEach((frame) => {
  // frame = { id, name, value }
  if (frame.name === "get_time") {
    wire.write({ ...frame, value: new Date().toISOString() });
  }
});
```

---

## Class Reference

### `class OpenAiStream implements AudioStream`

| Property / Method                     | Type                                             | Description                                                          |
| ------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| `format`                              | `ULawFormat`                                     | Always µ‑law 8 kHz.                                                  |
| `ready`                               | `Promise<void>`                                  | Resolves when the **session.updated** event arrives.                 |
| `transcript`                          | `AsyncReadStream<Transcript>`                    | Emits `{source, content}` for both user & agent transcription lines. |
| `write(chunk)`                        | `(Buffer) → Promise<void>`                       | Write raw µ‑law audio.                                               |
| `writeMessage(role, text)`            | `( "user" \| "system", string ) → Promise<void>` | Send a text message to the conversation.                             |
| `handleFunctionCalls(functionStream)` | `Promise<void>`                                  | Bidirectional pipe of OpenAI function‑call frames.                   |
| `handleDtmf(dtmfStream, signal)`      | `Promise<void>`                                  | Converts DTMF digits into system messages.                           |
| `update(config, tools)`               | `Promise<void>`                                  | Hot‑update session parameters (voice, temperature, …).               |
| `static create(key, cfg, tools)`      | `Promise<{stream, socket}>`                      | Opens the WS & performs initial `session.update`.                    |
| `static from(ws)`                     | `Promise<OpenAiStream>`                          | Wrap an **existing** WebSocket.                                      |

---

## Session Config

```ts
interface OpenAiSessionConfig {
  voice: OpenAiVoice; // "alloy" | "echo" | …
  instructions: string; // system prompt
  model: string; // e.g. "gpt-4o-audio-preview"
  temperature?: number; // default 0.8
  transcriptionModel?: string; // default "whisper-1"
  functions?: FunctionTool[]; // OpenAI function‑call tools
}
```

---

## Related Packages

| Package                                                                                                      | Purpose                                    |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| [`@silyze/async-audio-stream`](https://www.npmjs.com/package/@silyze/async-audio-stream)                     | Core duplex audio interfaces.              |
| [`@silyze/async-audio-format-ulaw`](https://www.npmjs.com/package/@silyze/async-audio-format-ulaw)           | µ‑law codec used internally.               |
| [`@silyze/async-openai-function-stream`](https://www.npmjs.com/package/@silyze/async-openai-function-stream) | JSON‑RPC bridge for OpenAI Function Calls. |
