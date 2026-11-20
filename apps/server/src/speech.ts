/**
 * Transcribes iMessage voice memos with ElevenLabs Speech-to-Text (Scribe), so a member can *speak*
 * a request ("split the $80 dinner between me, Neena and Akash") and Kitty acts on it exactly like a
 * typed message. One endpoint:
 *   POST /v1/speech-to-text   multipart { model_id, file }  ->  { text, language_code, words[] }
 * Off unless ELEVENLABS_API_KEY is set (the same key the booking-call agent uses).
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ImageRef, SpeechToText } from "@gta/core";

export interface ElevenLabsSpeechConfig {
  apiKey: string;
  /** Scribe model id. Defaults to scribe_v1. */
  modelId?: string;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class ElevenLabsSpeech implements SpeechToText {
  private readonly base = "https://api.elevenlabs.io";
  private readonly fetch: typeof fetch;

  constructor(private readonly config: ElevenLabsSpeechConfig) {
    this.fetch = config.fetchImpl ?? fetch;
  }

  async transcribe(audio: ImageRef): Promise<string> {
    const bytes = await readFile(audio.uri);
    const form = new FormData();
    form.append("model_id", this.config.modelId ?? "scribe_v1");
    form.append(
      "file",
      new Blob([bytes], { type: audio.mimeType ?? "audio/mp4" }),
      basename(audio.uri) || "memo.m4a",
    );
    const res = await this.fetch(`${this.base}/v1/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": this.config.apiKey },
      body: form,
    });
    const json = (await res.json().catch(() => ({}))) as {
      text?: string;
      detail?: unknown;
      message?: unknown;
    };
    if (!res.ok) {
      const detail = (json.detail ?? json.message ?? res.statusText) as unknown;
      throw new Error(`ElevenLabs STT ${res.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    }
    return (json.text ?? "").trim();
  }
}

/** ElevenLabs Scribe from the environment, or undefined when no key is set (voice memos stay unread). */
export function elevenLabsSpeechFromEnv(env: NodeJS.ProcessEnv = process.env): ElevenLabsSpeech | undefined {
  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) return undefined;
  const modelId = env.ELEVENLABS_STT_MODEL;
  return new ElevenLabsSpeech({ apiKey, ...(modelId ? { modelId } : {}) });
}
