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

export interface ILogOptions {
  log(area: string, message: string, extra?: object): void;
}

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

function isWebSocketClosedError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.message.includes("WebSocket is not open")) return true;
    if (
      "code" in error &&
      (error as { code?: unknown }).code === "ERR_WS_NOT_OPEN"
    ) {
      return true;
    }
  }
  if (error == null) return false;
  const message = String(error);
  return message.includes("WebSocket is not open");
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export default class OpenAiStream implements AudioStream {
  #transform: AsyncTransform<JsonValue>;
  #stream: AsyncStream<JsonValue>;

  #socket?: WebSocket;
  #logOptions?: ILogOptions;

  #tts?: TextToSpeachModel;

  #sessionUpdatedEvent: Promise<JsonValue | undefined>;

  #transcriptionTransform: AsyncTransform<Transcript>;
  #assistantTranscriptDelta: AsyncTransform<Transcript>;

  #activeResponseIds = new Set<string>();
  #canceledResponseIds = new Set<string>();
  #responseTextBuffer = new Map<string, string>();
  #ttsSpeakQueue: Promise<void> = Promise.resolve();
  #userSpeaking = false;

  constructor(
    stream: AsyncStream<JsonValue>,
    socket?: WebSocket,
    logOptions?: ILogOptions
  ) {
    this.#transform = stream.transform();
    this.#stream = stream;
    this.#socket = socket;
    this.#logOptions = logOptions;

    this.#sessionUpdatedEvent = this.#getSessionUpdatedEvent();
    this.#transcriptionTransform = this.#getTranscriptionTransform();
    this.#assistantTranscriptDelta =
      this.#getAssistantTranscriptDeltaTransform();

    this.#setupEventListeners();
    this.#logOperation("initialized", {
      hasSocket: Boolean(socket),
      loggingEnabled: Boolean(logOptions),
    });
  }

  #log(area: string, message: string, extra?: object) {
    this.#logOptions?.log(area, message, extra);
  }

  #logOperation(operation: string, extra?: object) {
    this.#log("OpenAiStream", operation, extra);
  }

  read(signal?: AbortSignal): AsyncIterable<Buffer> {
    this.#logOperation("read", {
      via: this.#tts ? "tts" : "ulaw",
      hasSignal: Boolean(signal),
    });
    if (this.#tts) {
      return this.#tts.read(signal);
    }
    return this.#ulawTransform.read(signal);
  }

  transform(): AsyncTransform<Buffer<ArrayBufferLike>> {
    this.#logOperation("transform");
    return new AsyncTransform(this);
  }

  get format(): AudioFormat {
    this.#logOperation("format", { useTtsFormat: Boolean(this.#tts?.format) });
    if (this.#tts?.format) return this.#tts.format;
    return new ULawFormat(8000);
  }

  get transcript(): AsyncReadStream<Transcript> {
    this.#logOperation("transcript");
    return this.#transcriptionTransform;
  }

  get transcriptDelta(): AsyncReadStream<Transcript> {
    this.#logOperation("transcriptDelta");
    return this.#assistantTranscriptDelta;
  }

  get ready(): Promise<void> {
    this.#logOperation("ready", { hasTts: Boolean(this.#tts) });
    if (this.#tts) {
      return Promise.all([
        this.#sessionUpdatedEvent.then(),
        this.#tts.ready,
      ]).then(() => {
        this.#logOperation("ready.complete", { hasTts: true });
      });
    }
    return this.#sessionUpdatedEvent.then((event) => {
      this.#logOperation("ready.complete", {
        hasTts: false,
        hasEvent: Boolean(event),
      });
    });
  }

  async writeMessage(role: "user" | "system", text: string) {
    this.#logOperation("writeMessage", {
      role,
      textLength: text.length,
      ttsEnabled: Boolean(this.#tts),
    });
    await this.#stream.write({
      type: "conversation.item.create",
      item: {
        type: "message",
        role,
        content: [{ type: "input_text", text }],
      },
    });
    this.#logOperation("writeMessage.conversationItemSent", {
      role,
      textLength: text.length,
    });

    const responseModalities: Array<"text" | "audio"> = this.#tts
      ? ["text"]
      : ["text", "audio"];

    await this.#stream.write({
      type: "response.create",
      response: { modalities: responseModalities },
    });
    this.#logOperation("writeMessage.responseCreateSent", {
      responseModalities,
    });
  }

  async write(input: Buffer<ArrayBufferLike>): Promise<void> {
    this.#logOperation("write", { byteLength: input.byteLength });
    await this.#stream.write({
      type: "input_audio_buffer.append",
      audio: input.toString("base64"),
    });
    this.#logOperation("write.complete");
  }

  async flush(): Promise<void> {
    this.#logOperation("flush");
    await this.#stream.write({ type: "input_audio_buffer.commit" });
    this.#logOperation("flush.complete");
  }

  async close(code?: number, reason?: string) {
    this.#logOperation("close.request", {
      code: code ?? 1000,
      reason: reason ?? "normal closure",
    });

    await this.#shutdownCurrentTts("close");
    this.#tts = undefined;
    this.#responseTextBuffer.clear();

    try {
      this.#socket?.close(code ?? 1000, reason ?? "normal closure");
    } catch (error) {
      this.#logOperation("close.socketError", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.#logOperation("close.complete");
  }

  async handleFunctionCalls(
    functionStream: FunctionStream,
    config?: AsyncTransformPipeConfig
  ) {
    this.#logOperation("handleFunctionCalls.start");
    await Promise.all([
      functionStream.transform().pipe(this.#stream, config),
      this.#stream.transform().pipe(functionStream, config),
    ]);
    this.#logOperation("handleFunctionCalls.complete");
  }

  async handleDtmf(dtmfStream: AsyncReadStream<string>, signal: AbortSignal) {
    this.#logOperation("handleDtmf.start");
    await dtmfStream
      .transform()
      .map((digit) => {
        this.#logOperation("handleDtmf.digit", { digit });
        return {
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
        };
      })
      .pipe(this.#stream, { signal })
      .catch((error) => {
        this.#logOperation("handleDtmf.error", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });
    this.#logOperation("handleDtmf.complete");
  }

  #setupEventListeners() {
    this.#logOperation("setupEventListeners");
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
    if (!responseId) {
      this.#logOperation("handleResponseCreated.missingResponseId");
      return;
    }

    this.#logOperation("handleResponseCreated", { responseId });

    this.#activeResponseIds.add(responseId);
    this.#canceledResponseIds.delete(responseId);
    this.#removeResponseBuffers(responseId);
  }

  #handleResponseOutputItemDone(event: Record<string, unknown>) {
    const responseId = getResponseIdFromData(event);
    if (!responseId) {
      this.#logOperation("handleResponseOutputItemDone.missingResponseId");
      return;
    }

    const outputIndex = getOutputIndex(event);
    const key = this.#bufferKey(responseId, outputIndex);
    const bufferedText = this.#responseTextBuffer.get(key);

    this.#logOperation("handleResponseOutputItemDone", {
      responseId,
      outputIndex,
      hasBufferedText: Boolean(bufferedText),
    });

    if (bufferedText && this.#tts) {
      this.#enqueueTtsSpeech(bufferedText);
    }

    this.#responseTextBuffer.delete(key);
    this.#clearResponse(responseId);
  }

  #handleResponseTermination(event: Record<string, unknown>) {
    const responseId = getResponseIdFromData(event);
    if (!responseId) {
      this.#logOperation("handleResponseTermination.missingResponseId");
      return;
    }
    this.#logOperation("handleResponseTermination", { responseId });
    this.#clearResponse(responseId);
  }

  #handleAssistantTextDeltaEvent(event: Record<string, unknown>) {
    if (!this.#tts) {
      this.#logOperation("handleAssistantTextDeltaEvent.noTts");
      return;
    }

    const delta = extractTextDelta(event);
    if (typeof delta !== "string" || delta.length === 0) {
      this.#logOperation("handleAssistantTextDeltaEvent.emptyDelta");
      return;
    }

    const responseId = getResponseIdFromData(event);
    if (!responseId) {
      this.#logOperation("handleAssistantTextDeltaEvent.missingResponseId");
      return;
    }

    const outputIndex = getOutputIndex(event);
    const key = this.#bufferKey(responseId, outputIndex);
    const previous = this.#responseTextBuffer.get(key) ?? "";
    this.#logOperation("handleAssistantTextDeltaEvent", {
      responseId,
      outputIndex,
      deltaLength: delta.length,
    });
    this.#responseTextBuffer.set(key, previous + delta);
  }

  #handleSpeechStarted() {
    this.#logOperation("handleSpeechStarted", {
      activeResponses: this.#activeResponseIds.size,
    });
    this.#userSpeaking = true;
    this.#cancelActiveResponses();
    this.#stopTtsPlayback();
  }

  #handleSpeechStopped() {
    this.#logOperation("handleSpeechStopped", {
      activeResponses: this.#activeResponseIds.size,
    });
    this.#userSpeaking = false;
  }

  #cancelActiveResponses() {
    this.#logOperation("cancelActiveResponses", {
      activeResponses: Array.from(this.#activeResponseIds),
    });
    for (const responseId of Array.from(this.#activeResponseIds)) {
      this.#cancelResponse(responseId);
    }
    this.#logOperation("cancelActiveResponses.complete");
  }

  #cancelResponse(responseId: string) {
    if (this.#canceledResponseIds.has(responseId)) {
      this.#logOperation("cancelResponse.skip", { responseId });
      return;
    }
    this.#canceledResponseIds.add(responseId);
    this.#removeResponseBuffers(responseId);

    this.#logOperation("cancelResponse.request", { responseId });

    void this.#stream
      .write({ type: "response.cancel", response_id: responseId })
      .then(() => {
        this.#logOperation("cancelResponse.sent", { responseId });
      })
      .catch((error) => {
        this.#logOperation("cancelResponse.error", {
          responseId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  #clearResponse(responseId: string) {
    this.#logOperation("clearResponse", { responseId });
    this.#activeResponseIds.delete(responseId);
    this.#canceledResponseIds.delete(responseId);
    this.#removeResponseBuffers(responseId);
    this.#logOperation("clearResponse.complete", {
      responseId,
      remainingActive: this.#activeResponseIds.size,
    });
  }

  #removeResponseBuffers(responseId: string) {
    const prefix = `${responseId}:`;
    const removedKeys: string[] = [];
    for (const key of Array.from(this.#responseTextBuffer.keys())) {
      if (key.startsWith(prefix)) {
        this.#responseTextBuffer.delete(key);
        removedKeys.push(key);
      }
    }
    this.#logOperation("removeResponseBuffers", {
      responseId,
      removedKeys,
    });
  }

  #bufferKey(responseId: string, outputIndex: number) {
    return `${responseId}:${outputIndex}`;
  }

  #enqueueTtsOperation(
    operation: (tts: TextToSpeachModel) => Promise<void> | void
  ) {
    const tts = this.#tts;
    if (!tts) {
      this.#logOperation("enqueueTtsOperation.noTts");
      return;
    }

    this.#logOperation("enqueueTtsOperation.queue");

    this.#ttsSpeakQueue = this.#ttsSpeakQueue
      .then(async () => {
        if (!this.#tts || this.#tts !== tts) {
          this.#logOperation("enqueueTtsOperation.skipped");
          return;
        }

        let attempt = 0;
        let lastError: unknown;
        while (attempt < 2) {
          try {
            await tts.ready;
            this.#logOperation("enqueueTtsOperation.execute", {
              attempt: attempt + 1,
            });
            await operation(tts);
            this.#logOperation("enqueueTtsOperation.done", {
              attempt: attempt + 1,
            });
            return;
          } catch (error) {
            lastError = error;
            const retryable = isWebSocketClosedError(error) && attempt === 0;
            if (!retryable) {
              throw error;
            }
            attempt += 1;
            this.#logOperation("enqueueTtsOperation.retry", {
              attempt,
              error: error instanceof Error ? error.message : String(error),
            });
            await delay(50);
          }
        }

        throw lastError instanceof Error
          ? lastError
          : new Error(String(lastError ?? "Unknown TTS error"));
      })
      .catch((error) => {
        this.#logOperation("enqueueTtsOperation.error", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  async #shutdownCurrentTts(reason: string) {
    const tts = this.#tts;
    if (!tts) {
      this.#logOperation("shutdownTts.skipped", { reason });
      return;
    }

    this.#logOperation("shutdownTts.start", { reason });

    this.#enqueueTtsOperation(async (model) => {
      const closable = (model as unknown as { close?: () => Promise<void> })
        .close;
      if (typeof closable === "function") {
        await closable.call(model);
        this.#logOperation("shutdownTts.closeCalled", { reason });
        return;
      }

      await model.speak("");
      this.#logOperation("shutdownTts.fallbackSpeak", { reason });
    });

    try {
      await this.#ttsSpeakQueue;
      this.#logOperation("shutdownTts.complete", { reason });
    } catch (error) {
      this.#logOperation("shutdownTts.queueError", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.#ttsSpeakQueue = Promise.resolve();
    }
  }

  #enqueueTtsSpeech(text: string) {
    if (this.#userSpeaking) {
      this.#logOperation("enqueueTtsSpeech.skippedUserSpeaking");
      return;
    }

    const tts = this.#tts;
    if (!tts) {
      this.#logOperation("enqueueTtsSpeech.noTts");
      return;
    }

    const normalized = normalizeWhitespace(text);
    if (!normalized) {
      this.#logOperation("enqueueTtsSpeech.empty");
      return;
    }

    this.#logOperation("enqueueTtsSpeech", { textLength: normalized.length });
    this.#enqueueTtsOperation((model) => model.speak(normalized));
  }

  #stopTtsPlayback() {
    const tts = this.#tts;
    if (!tts) {
      this.#logOperation("stopTtsPlayback.noTts");
      return;
    }

    this.#logOperation("stopTtsPlayback");

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
        this.#logOperation("stopTtsPlayback.stopCalled");
        return;
      }

      await model.speak("");
      this.#logOperation("stopTtsPlayback.fallbackSpeak");
    });
    this.#logOperation("stopTtsPlayback.queued");
  }

  async update(
    update: OpenAiSessionConfig,
    tools: JsonValue,
    externalVoiceModel?: TextToSpeachModel
  ) {
    this.#logOperation("update.start", {
      voice: update.voice,
      model: update.model,
      useExternalVoiceModel: Boolean(externalVoiceModel),
      temperature: update.temperature ?? 0.8,
      hasFunctions: Boolean(update.functions?.length),
    });
    assert(
      externalVoiceModel || update.voice,
      "Must provide at least one: `update.voice` or `externalVoiceModel`"
    );
    const useExternalVoice = Boolean(externalVoiceModel);

    const previousTts = this.#tts;
    if (previousTts && previousTts !== externalVoiceModel) {
      await this.#shutdownCurrentTts("update");
      if (this.#tts === previousTts) {
        this.#tts = undefined;
      }
    }

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
      instructions: update.instructions,
      modalities: useExternalVoice ? ["text"] : ["text", "audio"],
      temperature: update.temperature ?? 0.8,
    };

    if (!useExternalVoice) {
      session.output_audio_format = "g711_ulaw";
      session.voice = update.voice!;
    }

    this.#logOperation("update.writeSession", {
      useExternalVoice,
      modalities: session.modalities,
    });
    await this.#stream.write({
      type: "session.update",
      session,
    } as unknown as JsonValue);

    if (useExternalVoice && externalVoiceModel) {
      this.#logOperation("update.externalVoiceModel", {
        modelReady: Boolean(externalVoiceModel.ready),
      });
      this.#responseTextBuffer.clear();
      this.#tts = externalVoiceModel;
      await this.#tts.ready;
      this.#logOperation("update.externalVoiceModel.ready");
    } else {
      this.#logOperation("update.internalVoice");
      this.#tts = undefined;
      this.#responseTextBuffer.clear();
    }
    this.#logOperation("update.complete", {
      hasExternalTts: Boolean(this.#tts),
      bufferedResponses: this.#responseTextBuffer.size,
    });
  }

  static async from(websocket: WebSocket, logOptions?: ILogOptions) {
    logOptions?.log("OpenAiStream", "from.start", {
      readyState: websocket.readyState,
    });
    const stream = await getWebsocketStream(websocket, JsonEncoding, {
      clear: "all-read",
    });
    const instance = new OpenAiStream(stream, websocket, logOptions);
    logOptions?.log("OpenAiStream", "from.complete", {
      readyState: websocket.readyState,
    });
    return instance;
  }

  static async create(
    secretKey: string,
    config: OpenAiSessionConfig,
    tools: FunctionTool[],
    externalVoiceModel?: TextToSpeachModel,
    logOptions?: ILogOptions
  ) {
    logOptions?.log("OpenAiStream", "create.start", {
      model: config.model,
      hasTools: Boolean(tools?.length),
      hasExternalVoiceModel: Boolean(externalVoiceModel),
    });

    const socket = new WebSocket(getOpenAiUrl(config.model), {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    const stream = await OpenAiStream.from(socket, logOptions);
    await stream.update(
      config,
      tools as unknown as JsonValue,
      externalVoiceModel
    );
    logOptions?.log("OpenAiStream", "create.complete", {
      socketReadyState: socket.readyState,
    });
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
      const buffer = Buffer.from(data.delta, "base64");
      this.#logOperation("ulawTransform.chunk", {
        byteLength: buffer.byteLength,
      });
      return buffer;
    });
  }

  async #getSessionUpdatedEvent() {
    this.#logOperation("getSessionUpdatedEvent.await");
    const updatedEvent = await this.#transform.first(
      (data) =>
        typeof data === "object" &&
        data !== null &&
        "type" in data &&
        data.type === "session.updated"
    );
    this.#logOperation("getSessionUpdatedEvent.resolved", {
      hasEvent: Boolean(updatedEvent),
    });
    return updatedEvent;
  }

  #getTranscriptionTransform(): AsyncTransform<Transcript> {
    this.#logOperation("getTranscriptionTransform.create");
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
          this.#logOperation("transcript.assistantDone", {
            length: data.transcript.length,
          });
          return {
            source: "agent",
            content: data.transcript,
          } as Transcript;
        }

        if (isUserTranscriptCompleted(data)) {
          assertHasProperty(data, "transcript", "data");
          assertType(data.transcript, "string", "data.transcript");
          this.#logOperation("transcript.userCompleted", {
            length: data.transcript.length,
          });
          return {
            source: "user",
            content: data.transcript,
          } as Transcript;
        }

        if (isAssistantTextDone(data)) {
          const transcript = extractTextDelta(data);
          if (typeof transcript === "string" && transcript.length > 0) {
            this.#logOperation("transcript.assistantTextDone", {
              length: transcript.length,
            });
            return { source: "agent", content: transcript } as Transcript;
          }
        }

        if (isResponseOutputItemDone(data)) {
          const responseData = data as Record<string, unknown>;
          const item = responseData.item;
          const transcript = extractTextFromResponseItem(item);
          if (typeof transcript === "string" && transcript.length > 0) {
            this.#logOperation("transcript.responseOutputItemDone", {
              length: transcript.length,
            });
            return { source: "agent", content: transcript } as Transcript;
          }
        }

        assert(false, "Invalid data type for transcription transform");
      });
  }

  #getAssistantTranscriptDeltaTransform(): AsyncTransform<Transcript> {
    this.#logOperation("getAssistantTranscriptDeltaTransform.create");
    return this.#transform
      .filter(
        (data) => isAssistantTranscriptDelta(data) || isAssistantTextDelta(data)
      )
      .map((data) => {
        assertType(data, "object", "data");

        if (isAssistantTranscriptDelta(data)) {
          assertHasProperty(data, "delta", "data");
          assertType(data.delta, "string", "data.delta");
          this.#logOperation("transcriptDelta.assistantTranscript", {
            length: data.delta.length,
          });
          return { source: "agent", content: data.delta } as Transcript;
        }

        const delta = extractTextDelta(data);
        assertType(delta ?? "", "string", "assistant text delta");
        this.#logOperation("transcriptDelta.assistantText", {
          length: delta?.length ?? 0,
        });
        return { source: "agent", content: delta ?? "" } as Transcript;
      });
  }
}
