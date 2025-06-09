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
  voice: OpenAiVoice;
  instructions: string;
  model: string;
  temperature?: number;
  transcriptionModel?: string;
  functions?: FunctionTool[];
};

const OPENAI_WS_URL = `wss://api.openai.com/v1/realtime`;
function getOpenAiUrl(model?: string) {
  const url = new URL(OPENAI_WS_URL);
  if (model) {
    url.searchParams.set("model", model);
  }
  return url;
}

export class OpenAiStream implements AudioStream {
  #transform: AsyncTransform<JsonValue>;
  #stream: AsyncStream<JsonValue>;

  get _transform() {
    return this.#transform;
  }

  constructor(stream: AsyncStream<JsonValue>) {
    this.#transform = stream.transform();
    this.#stream = stream;
    this.#sessionUpdatedEvent = this.#getSessionUpdatedEvent();
    this.#transcriptionTransform = this.#getTranscriptionTransform();
  }

  read(signal?: AbortSignal): AsyncIterable<Buffer> {
    return this.#ulawTransform.read(signal);
  }
  transform(): AsyncTransform<Buffer<ArrayBufferLike>> {
    return new AsyncTransform(this);
  }
  get format(): AudioFormat {
    return new ULawFormat(8000);
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

  #getTranscriptionTransform(): AsyncTransform<Transcript> {
    return this.#transform
      .filter(
        (data) =>
          typeof data === "object" &&
          data !== null &&
          "type" in data &&
          (data.type === "response.audio_transcript.done" ||
            data.type ===
              "conversation.item.input_audio_transcription.completed")
      )
      .map((data) => {
        assertType(data, "object", "data");
        assertHasProperty(data, "type", "data");
        assertType(data.type, "string", "data.type");

        if (data.type === "response.audio_transcript.done") {
          assertHasProperty(data, "transcript", "data");
          assertType(data.transcript, "string", "data.transcript");
          return { source: "agent", content: data.transcript } as Transcript;
        }

        if (
          data.type === "conversation.item.input_audio_transcription.completed"
        ) {
          assertHasProperty(data, "transcript", "data");
          assertType(data.transcript, "string", "data.transcript");
          return {
            source: "user",
            content: data.transcript,
          } as Transcript;
        }
        assert(false, "Invalid data type");
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

  #transcriptionTransform: AsyncTransform<Transcript>;
  #sessionUpdatedEvent: Promise<JsonValue | undefined>;

  get transcript(): AsyncReadStream<Transcript> {
    return this.#transcriptionTransform;
  }

  get ready(): Promise<void> {
    return this.#sessionUpdatedEvent.then();
  }

  async writeMessage(role: "user" | "system", text: string) {
    await this.#stream.write({
      type: "conversation.item.create",
      item: {
        type: "message",
        role,
        content: [
          {
            type: "input_text",
            text,
          },
        ],
      },
    });

    await this.#stream.write({
      type: "response.create",
      response: {
        modalities: ["text", "audio"],
      },
    });
  }

  async write(input: Buffer<ArrayBufferLike>): Promise<void> {
    await this.#stream.write({
      type: "input_audio_buffer.append",
      audio: input.toString("base64"),
    });
  }

  static async from(websocket: WebSocket) {
    return new OpenAiStream(
      await getWebsocketStream(websocket, JsonEncoding, {
        clear: "all-read",
      })
    );
  }

  async handleDtmf(dtmfStream: AsyncReadStream<string>, signal: AbortSignal) {
    await dtmfStream
      .transform()
      .map((digit) => [
        {
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
        },
      ])
      .flatMap((item) => item)
      .pipe(this.#stream, { signal });
  }

  async update(update: OpenAiSessionConfig, tools: JsonValue) {
    await this.#stream.write({
      type: "session.update",
      session: {
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
      },
    });
  }

  static async create(
    secretKey: string,
    config: OpenAiSessionConfig,
    tools: FunctionTool[]
  ) {
    const socket = new WebSocket(getOpenAiUrl(config.model), {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });
    const stream = await OpenAiStream.from(socket);

    await stream.update(config, tools as unknown as JsonValue);

    return { stream, socket };
  }

  get #ulawTransform() {
    return this.#transform
      .filter(
        (data) =>
          typeof data === "object" &&
          data !== null &&
          "type" in data &&
          data.type === "response.audio.delta"
      )
      .map((data) => {
        assertType(data, "object", "data");
        assertHasProperty(data, "delta", "data");
        assertType(data.delta, "string", "data");
        return Buffer.from(data.delta, "base64");
      });
  }
}
