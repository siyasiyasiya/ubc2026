import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ElevenLabsSpeech, elevenLabsSpeechFromEnv } from "./speech.js";

async function tempAudio(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kitty-stt-"));
  const path = join(dir, "memo.caf");
  await writeFile(path, Buffer.from([0, 1, 2, 3]));
  return path;
}

describe("ElevenLabsSpeech", () => {
  it("posts the audio to Scribe and returns the transcript", async () => {
    const uri = await tempAudio();
    let seen: { url: string; model: unknown; key: unknown } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const form = init.body as FormData;
      seen = { url: String(url), model: form.get("model_id"), key: (init.headers as Record<string, string>)["xi-api-key"] };
      return new Response(JSON.stringify({ text: "  split the dinner three ways  " }), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await new ElevenLabsSpeech({ apiKey: "k", fetchImpl }).transcribe({ uri, mimeType: "audio/x-caf" });
    expect(out).toBe("split the dinner three ways"); // trimmed
    expect(seen?.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(seen?.model).toBe("scribe_v1");
    expect(seen?.key).toBe("k");
    await rm(join(uri, ".."), { recursive: true, force: true });
  });

  it("throws a readable error on a non-ok response", async () => {
    const uri = await tempAudio();
    const fetchImpl = (async () => new Response(JSON.stringify({ detail: "bad audio" }), { status: 422 })) as unknown as typeof fetch;
    await expect(new ElevenLabsSpeech({ apiKey: "k", fetchImpl }).transcribe({ uri })).rejects.toThrow(/ElevenLabs STT 422: bad audio/);
    await rm(join(uri, ".."), { recursive: true, force: true });
  });

  it("is off without an API key", () => {
    expect(elevenLabsSpeechFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(elevenLabsSpeechFromEnv({ ELEVENLABS_API_KEY: "k" } as NodeJS.ProcessEnv)).toBeInstanceOf(ElevenLabsSpeech);
  });
});
