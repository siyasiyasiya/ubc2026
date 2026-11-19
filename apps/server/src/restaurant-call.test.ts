import { describe, expect, it } from "vitest";
import { ElevenLabsRestaurantCaller } from "./restaurant-call.js";
import { toE164 } from "./runtime.js";

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const request = { restaurant: "Uchi", phone: "+15125550100", partySize: 4, when: "tomorrow 7:30pm", reservationName: "Neena", group: "Roommates" };

describe("ElevenLabsRestaurantCaller", () => {
  it("starts an outbound call with the details as dynamic variables", async () => {
    const { fetchFn, calls } = fakeFetch([{ body: { success: true, message: "ok", conversation_id: "conv_1", callSid: "CA1" } }]);
    const caller = new ElevenLabsRestaurantCaller({ apiKey: "k", agentId: "agent_1", phoneNumberId: "pn_1", fetch: fetchFn });
    expect(await caller.start(request)).toEqual({ callId: "conv_1" });
    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/convai/twilio/outbound-call");
    expect((calls[0]!.init.headers as Record<string, string>)["xi-api-key"]).toBe("k");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ agent_id: "agent_1", agent_phone_number_id: "pn_1", to_number: "+15125550100" });
    expect(body.conversation_initiation_client_data.dynamic_variables).toMatchObject({ restaurant: "Uchi", party_size: 4, reservation_name: "Neena" });
  });

  it("reads a booked call, an unanswered one, and one still in progress", async () => {
    const { fetchFn } = fakeFetch([
      { body: { status: "processing", analysis: null } },
      {
        body: {
          status: "done",
          metadata: { phone_call: { call_result: "answered" } },
          analysis: {
            transcript_summary: "Booked a table for 4 at 7:45.",
            data_collection_results: { reservation_confirmed: { value: true }, confirmed_time: { value: "7:45pm" }, alternative_offered: { value: null } },
          },
        },
      },
      { body: { status: "done", metadata: { phone_call: { call_result: "voicemail" } }, analysis: { transcript_summary: "", data_collection_results: {} } } },
    ]);
    const caller = new ElevenLabsRestaurantCaller({ apiKey: "k", agentId: "a", phoneNumberId: "p", fetch: fetchFn });
    expect(await caller.result("c")).toEqual({ status: "in_progress" });
    expect(await caller.result("c")).toEqual({ status: "done", pickedUp: "answered", booked: true, confirmedTime: "7:45pm", summary: "Booked a table for 4 at 7:45." });
    expect(await caller.result("c")).toMatchObject({ status: "done", pickedUp: "voicemail" });
  });

  it("surfaces an API error", async () => {
    const { fetchFn } = fakeFetch([{ status: 401, body: { detail: "invalid api key" } }]);
    const caller = new ElevenLabsRestaurantCaller({ apiKey: "bad", agentId: "a", phoneNumberId: "p", fetch: fetchFn });
    await expect(caller.start(request)).rejects.toThrow("ElevenLabs 401: invalid api key");
  });
});

describe("toE164", () => {
  it("normalizes US numbers and rejects junk", () => {
    expect(toE164("+1 (512) 555-0100")).toBe("+15125550100");
    expect(toE164("512-555-0100")).toBe("+15125550100");
    expect(toE164("15125550100")).toBe("+15125550100");
    expect(toE164("call them")).toBeUndefined();
  });
});
