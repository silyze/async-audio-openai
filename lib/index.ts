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

const isAssistantTextDone = (data: unknown) =>
  typeof data === "object" &&
  data !== null &&
  "type" in data &&
  (data.type === "response.output_text.done" ||
    data.type === "response.text.done");

const isResponseCreated = (
  data: unknown
): data is {
  type: "response.created";
  response: { id: string };
} =>
  typeof data === "object" &&
  data !== null &&
  "type" in data &&
  data.type === "response.created" &&
  "response" in data &&
  typeof (data as any).response === "object" &&
  (data as any).response !== null &&
  "id" in (data as any).response &&
  typeof (data as any).response.id === "string";

const isResponseOutputItemDone = (
  data: unknown
): data is {
  type: "response.output_item.done";
  response_id: string;
  output_index?: number;
  item?: unknown;
} =>
  typeof data === "object" &&
  data !== null &&
  "type" in data &&
  data.type === "response.output_item.done" &&
  "response_id" in data &&
  typeof (data as any).response_id === "string";

const isResponseCanceled = (data: unknown) =>
  typeof data === "object" &&
  data !== null &&
  "type" in data &&
  (data.type === "response.canceled" || data.type === "response.cancelled");

const isResponseFailed = (data: unknown) =>
  typeof data === "object" &&
  data !== null &&
  "type" in data &&
  (data.type === "response.failed" || data.type === "response.error");

const isInputSpeechStarted = (data: unknown) =>
  typeof data === "object" &&
  data !== null &&
  "type" in data &&
  data.type === "input_audio_buffer.speech_started";

const isInputSpeechStopped = (data: unknown) =>
  typeof data === "object" &&
  data !== null &&
  "type" in data &&
  data.type === "input_audio_buffer.speech_stopped";

function getResponseIdFromData(
  data: Record<string, unknown>,
  fallbackField: "response_id" | "id" = "response_id"
): string | undefined {
  if (fallbackField in data && typeof data[fallbackField] === "string") {
    return data[fallbackField] as string;
  }

  if ("response" in data && typeof data.response === "object") {
    const response = data.response as Record<string, unknown>;
    if ("id" in response && typeof response.id === "string") {
      return response.id as string;
    }
  }

  return undefined;
}

function getOutputIndex(data: Record<string, unknown>): number {
  const index = data.output_index;
  return typeof index === "number" && Number.isFinite(index) ? index : 0;
}

function extractTextFromResponseItem(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const itemRecord = item as Record<string, unknown>;

  if (!("content" in itemRecord) || !Array.isArray(itemRecord.content)) {
    return undefined;
  }

  for (const part of itemRecord.content) {
    if (typeof part !== "object" || part === null) continue;
    const partRecord = part as Record<string, unknown>;

    if ("text" in partRecord && typeof partRecord.text === "string") {
      return partRecord.text;
    }
  }

  return undefined;
}

function normalizeWhitespace(input: string) {
  return input.replace(/\s+/g, " ").trim();
}

function hasAssistantTextContent(data: unknown): boolean {
  if (isAssistantTextDone(data)) {
    return true;
  }

  if (
    isResponseOutputItemDone(data) &&
    typeof data === "object" &&
    data !== null &&
    "item" in data
  ) {
    const item = (data as Record<string, unknown>).item;
    return extractTextFromResponseItem(item) !== undefined;
  }

  return false;
}

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

  #activeResponseIds = new Set<string>();
  #canceledResponseIds = new Set<string>();
  #responseTextBuffer = new Map<string, string>();
  #ttsSpeakQueue: Promise<void> = Promise.resolve();
  #userSpeaking = false;

  constructor(stream: AsyncStream<JsonValue>, socket?: WebSocket) {
    this.#transform = stream.transform();
    this.#stream = stream;
    this.#socket = socket;

    this.#sessionUpdatedEvent = this.#getSessionUpdatedEvent();
    this.#transcriptionTransform = this.#getTranscriptionTransform();
    this.#assistantTranscriptDelta =
      this.#getAssistantTranscriptDeltaTransform();

    this.#setupEventListeners();
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

    const responseModalities: Array<"text" | "audio"> = this.#tts
      ? ["text"]
      : ["text", "audio"];

    await this.#stream.write({
      type: "response.create",
      response: { modalities: responseModalities },
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

  #setupEventListeners() {
    void this.#transform
      .filter(isResponseCreated)
      .forEach((event) =>
        this.#handleResponseCreated(event as Record<string, unknown>)
      );

    void this.#transform
      .filter(isResponseOutputItemDone)
      .forEach((event) =>
        this.#handleResponseOutputItemDone(event as Record<string, unknown>)
      );

    void this.#transform
      .filter((event) => isResponseCanceled(event) || isResponseFailed(event))
      .forEach((event) =>
        this.#handleResponseTermination(event as Record<string, unknown>)
      );

    void this.#transform
      .filter(isAssistantTextDelta)
      .forEach((event) =>
        this.#handleAssistantTextDeltaEvent(event as Record<string, unknown>)
      );

    void this.#transform
      .filter(isInputSpeechStarted)
      .forEach(() => this.#handleSpeechStarted());

    void this.#transform
      .filter(isInputSpeechStopped)
      .forEach(() => this.#handleSpeechStopped());
  }

  #handleResponseCreated(event: Record<string, unknown>) {
    const responseId = getResponseIdFromData(event);
    if (!responseId) return;

    this.#activeResponseIds.add(responseId);
    this.#canceledResponseIds.delete(responseId);
    this.#removeResponseBuffers(responseId);
  }

  #handleResponseOutputItemDone(event: Record<string, unknown>) {
    const responseId = getResponseIdFromData(event);
    if (!responseId) return;

    const outputIndex = getOutputIndex(event);
    const key = this.#bufferKey(responseId, outputIndex);
    const bufferedText = this.#responseTextBuffer.get(key);

    if (bufferedText && this.#tts) {
      this.#enqueueTtsSpeech(bufferedText);
    }

    this.#responseTextBuffer.delete(key);
    this.#clearResponse(responseId);
  }

  #handleResponseTermination(event: Record<string, unknown>) {
    const responseId = getResponseIdFromData(event);
    if (!responseId) return;
    this.#clearResponse(responseId);
  }

  #handleAssistantTextDeltaEvent(event: Record<string, unknown>) {
    if (!this.#tts) return;

    const delta = extractTextDelta(event);
    if (typeof delta !== "string" || delta.length === 0) return;

    const responseId = getResponseIdFromData(event);
    if (!responseId) return;

    const outputIndex = getOutputIndex(event);
    const key = this.#bufferKey(responseId, outputIndex);
    const previous = this.#responseTextBuffer.get(key) ?? "";
    this.#responseTextBuffer.set(key, previous + delta);
  }

  #handleSpeechStarted() {
    this.#userSpeaking = true;
    this.#cancelActiveResponses();
    this.#stopTtsPlayback();
  }

  #handleSpeechStopped() {
    this.#userSpeaking = false;
  }

  #cancelActiveResponses() {
    for (const responseId of Array.from(this.#activeResponseIds)) {
      this.#cancelResponse(responseId);
    }
  }

  #cancelResponse(responseId: string) {
    if (this.#canceledResponseIds.has(responseId)) return;
    this.#canceledResponseIds.add(responseId);
    this.#removeResponseBuffers(responseId);

    void this.#stream
      .write({ type: "response.cancel", response_id: responseId })
      .catch(() => {});
  }

  #clearResponse(responseId: string) {
    this.#activeResponseIds.delete(responseId);
    this.#canceledResponseIds.delete(responseId);
    this.#removeResponseBuffers(responseId);
  }

  #removeResponseBuffers(responseId: string) {
    const prefix = `${responseId}:`;
    for (const key of Array.from(this.#responseTextBuffer.keys())) {
      if (key.startsWith(prefix)) {
        this.#responseTextBuffer.delete(key);
      }
    }
  }

  #bufferKey(responseId: string, outputIndex: number) {
    return `${responseId}:${outputIndex}`;
  }

  #enqueueTtsOperation(
    operation: (tts: TextToSpeachModel) => Promise<void> | void
  ) {
    const tts = this.#tts;
    if (!tts) return;

    this.#ttsSpeakQueue = this.#ttsSpeakQueue
      .then(async () => {
        if (!this.#tts || this.#tts !== tts) {
          return;
        }
        await operation(tts);
      })
      .catch(() => {});
  }

  #enqueueTtsSpeech(text: string) {
    if (this.#userSpeaking) return;

    const tts = this.#tts;
    if (!tts) return;

    const normalized = normalizeWhitespace(text);
    if (!normalized) return;

    this.#enqueueTtsOperation((model) => model.speak(normalized));
  }

  #stopTtsPlayback() {
    const tts = this.#tts;
    if (!tts) return;

    for (const responseId of Array.from(this.#activeResponseIds)) {
      this.#removeResponseBuffers(responseId);
    }

    this.#enqueueTtsOperation(async (model) => {
      const maybeStop = (
        model as {
          stop?: () => Promise<void> | void;
        }
      ).stop;

      if (typeof maybeStop === "function") {
        await maybeStop.call(model);
        return;
      }

      await model.speak("");
    });
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
      turn_detection: {
        type: "server_vad";
        threshold: number;
        silence_duration_ms: number;
        prefix_padding_ms: number;
        create_response: boolean;
        interrupt_response: boolean;
      };
      input_audio_format: string;
      output_audio_format?: string;
      voice?: OpenAiVoice;
      instructions: string;
      modalities: Array<"text" | "audio">;
      temperature: number;
    } = {
      tools,
      input_audio_transcription: {
        model: update.transcriptionModel ?? "whisper-1",
      },
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        silence_duration_ms: 600,
        prefix_padding_ms: 400,
        create_response: true,
        interrupt_response: true,
      },
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
      session.output_audio_format = undefined;
    }

    await this.#stream.write({
      type: "session.update",
      session,
    } as unknown as JsonValue);

    if (externalVoiceModel) {
      this.#responseTextBuffer.clear();
      this.#ttsSpeakQueue = Promise.resolve();
      this.#tts = externalVoiceModel;
      await this.#tts.ready;
    } else {
      this.#tts = undefined;
      this.#responseTextBuffer.clear();
      this.#ttsSpeakQueue = Promise.resolve();
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
          isAssistantTranscriptDone(data) ||
          isUserTranscriptCompleted(data) ||
          hasAssistantTextContent(data)
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

        if (isAssistantTextDone(data)) {
          const transcript = extractTextDelta(data);
          if (typeof transcript === "string" && transcript.length > 0) {
            return { source: "agent", content: transcript } as Transcript;
          }
        }

        if (isResponseOutputItemDone(data)) {
          const responseData = data as Record<string, unknown>;
          const item = responseData.item;
          const transcript = extractTextFromResponseItem(item);
          if (typeof transcript === "string" && transcript.length > 0) {
            return { source: "agent", content: transcript } as Transcript;
          }
        }

        assert(false, "Invalid data type for transcription transform");
      });
  }

  #getAssistantTranscriptDeltaTransform(): AsyncTransform<Transcript> {
    return this.#transform
      .filter(
        (data) => isAssistantTranscriptDelta(data) || isAssistantTextDelta(data)
      )
      .map((data) => {
        assertType(data, "object", "data");

        if (isAssistantTranscriptDelta(data)) {
          assertHasProperty(data, "delta", "data");
          assertType(data.delta, "string", "data.delta");
          return { source: "agent", content: data.delta } as Transcript;
        }

        const delta = extractTextDelta(data);
        assertType(delta ?? "", "string", "assistant text delta");
        return { source: "agent", content: delta ?? "" } as Transcript;
      });
  }
}
