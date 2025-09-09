import { WebSocket } from "ws";
import { assert, assertHasProperty, assertType } from "@mojsoski/assert";

import {
  AsyncStream,
  AsyncTransform,
  AsyncReadStream,
  AsyncTransformPipeConfig,
} from "@mojsoski/async-stream";
import {
  getWebsocketStream,
  JsonEncoding,
  JsonValue,
} from "@mojsoski/async-websocket-stream";

import {
  AudioStream,
  AudioFormat,
  Transcript,
} from "@silyze/async-audio-stream";
import {
  FunctionStream,
  FunctionTool,
} from "@silyze/async-openai-function-stream";
import ULawFormat from "@silyze/async-audio-format-ulaw";
import TextToSpeachModel from "@silyze/async-audio-tts";

export type OpenAiVoice =
  | "alloy"
  | "ash"
  | "ballad"
  | "coral"
  | "echo"
  | "sage"
  | "shimmer"
  | "verse";

export type OpenAiSessionConfig = {
  voice?: OpenAiVoice;
  instructions: string;
  model: string;
  temperature?: number;
  transcriptionModel?: string;
  functions?: FunctionTool[];
};

const OPENAI_WS_URL = `wss://api.openai.com/v1/realtime`;
function getOpenAiUrl(model?: string) {
  const url = new URL(OPENAI_WS_URL);
  if (model) url.searchParams.set("model", model);
  return url;
}

const isAudioDelta = (data: unknown) =>
  typeof data === "object" &&
  data !== null &&
  "type" in data &&
  (data.type === "response.audio.delta" ||
    data.type === "response.output_audio.delta");

const isAssistantTranscriptDone = (data: unknown) =>
  typeof data === "object" &&
  data !== null &&
  "type" in data &&
  data.type === "response.audio_transcript.done";

const isAssistantTranscriptDelta = (data: unknown) =>
  typeof data === "object" &&
  data !== null &&
  "type" in data &&
  data.type === "response.audio_transcript.delta";

const isUserTranscriptCompleted = (data: unknown) =>
  typeof data === "object" &&
  data !== null &&
  "type" in data &&
  data.type === "conversation.item.input_audio_transcription.completed";

const isAssistantTextDelta = (data: unknown) =>
  typeof data === "object" &&
  data !== null &&
  "type" in data &&
  (data.type === "response.output_text.delta" ||
    data.type === "response.text.delta");

function extractTextDelta(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  if ("delta" in data && typeof data.delta === "string") return data.delta;
  if ("text" in data && typeof data.text === "string") return data.text;
  return undefined;
}

export default class OpenAiStream implements AudioStream {
  #transform: AsyncTransform<JsonValue>;
  #stream: AsyncStream<JsonValue>;

  #socket?: WebSocket;

  #tts?: TextToSpeachModel;

  #sessionUpdatedEvent: Promise<JsonValue | undefined>;

  #transcriptionTransform: AsyncTransform<Transcript>;
  #assistantTranscriptDelta: AsyncTransform<Transcript>;

  constructor(stream: AsyncStream<JsonValue>, socket?: WebSocket) {
    this.#transform = stream.transform();
    this.#stream = stream;
    this.#socket = socket;

    this.#sessionUpdatedEvent = this.#getSessionUpdatedEvent();
    this.#transcriptionTransform = this.#getTranscriptionTransform();
    this.#assistantTranscriptDelta =
      this.#getAssistantTranscriptDeltaTransform();
  }

  read(signal?: AbortSignal): AsyncIterable<Buffer> {
    if (this.#tts) {
      return this.#tts.read(signal);
    }
    return this.#ulawTransform.read(signal);
  }

  transform(): AsyncTransform<Buffer<ArrayBufferLike>> {
    return new AsyncTransform(this);
  }

  get format(): AudioFormat {
    if (this.#tts?.format) return this.#tts.format;
    return new ULawFormat(8000);
  }

  get transcript(): AsyncReadStream<Transcript> {
    return this.#transcriptionTransform;
  }

  get transcriptDelta(): AsyncReadStream<Transcript> {
    return this.#assistantTranscriptDelta;
  }

  get ready(): Promise<void> {
    if (this.#tts) {
      return Promise.all([
        this.#sessionUpdatedEvent.then(),
        this.#tts.ready,
      ]).then(() => {});
    }
    return this.#sessionUpdatedEvent.then();
  }

  async writeMessage(role: "user" | "system", text: string) {
    await this.#stream.write({
      type: "conversation.item.create",
      item: {
        type: "message",
        role,
        content: [{ type: "input_text", text }],
      },
    });

    await this.#stream.write({
      type: "response.create",
      response: { modalities: ["text", "audio"] },
    });
  }

  async write(input: Buffer<ArrayBufferLike>): Promise<void> {
    await this.#stream.write({
      type: "input_audio_buffer.append",
      audio: input.toString("base64"),
    });
  }

  async flush(): Promise<void> {
    await this.#stream.write({ type: "input_audio_buffer.commit" });
  }

  async close(code?: number, reason?: string) {
    try {
      await this.#tts?.speak("");
    } catch {}
    try {
      this.#socket?.close(code ?? 1000, reason ?? "normal closure");
    } catch {}
  }

  async handleFunctionCalls(
    functionStream: FunctionStream,
    config?: AsyncTransformPipeConfig
  ) {
    await Promise.all([
      functionStream.transform().pipe(this.#stream, config),
      this.#stream.transform().pipe(functionStream, config),
    ]);
  }

  async handleDtmf(dtmfStream: AsyncReadStream<string>, signal: AbortSignal) {
    await dtmfStream
      .transform()
      .map((digit) => ({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: `DTMF digit pressed by user: ${digit}`,
            },
          ],
        },
      }))
      .pipe(this.#stream, { signal });
  }

  async update(
    update: OpenAiSessionConfig,
    tools: JsonValue,
    externalVoiceModel?: TextToSpeachModel
  ) {
    assert(
      externalVoiceModel || update.voice,
      "Must provide at least one: `update.voice` or `externalVoiceModel`"
    );

    const session: {
      tools: JsonValue;
      input_audio_transcription: { model: string };
      turn_detection: { type: string };
      input_audio_format: string;
      output_audio_format: string;
      voice?: OpenAiVoice;
      instructions: string;
      modalities: Array<"text" | "audio">;
      temperature: number;
    } = {
      tools,
      input_audio_transcription: {
        model: update.transcriptionModel ?? "whisper-1",
      },
      turn_detection: { type: "server_vad" },
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
      voice: update.voice,
      instructions: update.instructions,
      modalities: ["text", "audio"],
      temperature: update.temperature ?? 0.8,
    };

    if (externalVoiceModel) {
      session.voice = undefined;
      session.modalities = ["text"];
    }

    await this.#stream.write({ type: "session.update", session });

    if (externalVoiceModel) {
      this.#tts = externalVoiceModel;
      await this.#tts.ready;

      void this.#assistantTextDeltaTransform()
        .filter((t) => t.length > 0)
        .forEach(async (text) => {
          try {
            if (this.#tts) {
              await this.#tts.speak(text);
            }
          } catch {}
        });
    } else {
      this.#tts = undefined;
    }
  }

  static async from(websocket: WebSocket) {
    return new OpenAiStream(
      await getWebsocketStream(websocket, JsonEncoding, { clear: "all-read" }),
      websocket
    );
  }

  static async create(
    secretKey: string,
    config: OpenAiSessionConfig,
    tools: FunctionTool[],
    externalVoiceModel?: TextToSpeachModel
  ) {
    const socket = new WebSocket(getOpenAiUrl(config.model), {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    const stream = await OpenAiStream.from(socket);
    await stream.update(
      config,
      tools as unknown as JsonValue,
      externalVoiceModel
    );
    return { stream, socket };
  }

  get _transform() {
    return this.#transform;
  }

  get #ulawTransform() {
    return this.#transform.filter(isAudioDelta).map((data) => {
      assertType(data, "object", "data");
      assertHasProperty(data, "delta", "data");
      assertType(data.delta, "string", "data.delta");
      return Buffer.from(data.delta, "base64");
    });
  }

  async #getSessionUpdatedEvent() {
    const updatedEvent = await this.#transform.first(
      (data) =>
        typeof data === "object" &&
        data !== null &&
        "type" in data &&
        data.type === "session.updated"
    );
    return updatedEvent;
  }

  #getTranscriptionTransform(): AsyncTransform<Transcript> {
    return this.#transform
      .filter(
        (data) =>
          isAssistantTranscriptDone(data) || isUserTranscriptCompleted(data)
      )
      .map((data) => {
        assertType(data, "object", "data");
        assertHasProperty(data, "type", "data");
        assertType(data.type, "string", "data.type");

        if (isAssistantTranscriptDone(data)) {
          assertHasProperty(data, "transcript", "data");
          assertType(data.transcript, "string", "data.transcript");
          return {
            source: "agent",
            content: data.transcript,
          } as Transcript;
        }

        if (isUserTranscriptCompleted(data)) {
          assertHasProperty(data, "transcript", "data");
          assertType(data.transcript, "string", "data.transcript");
          return {
            source: "user",
            content: data.transcript,
          } as Transcript;
        }

        assert(false, "Invalid data type for transcription transform");
      });
  }

  #getAssistantTranscriptDeltaTransform(): AsyncTransform<Transcript> {
    return this.#transform.filter(isAssistantTranscriptDelta).map((data) => {
      assertType(data, "object", "data");
      assertHasProperty(data, "delta", "data");
      assertType(data.delta, "string", "data.delta");
      return { source: "agent", content: data.delta } as Transcript;
    });
  }

  #assistantTextDeltaTransform(): AsyncTransform<string> {
    return this.#transform.filter(isAssistantTextDelta).map((data) => {
      assertType(data, "object", "data");
      const delta = extractTextDelta(data);
      assertType(delta ?? "", "string", "assistant text delta");
      return delta ?? "";
    });
  }
}
