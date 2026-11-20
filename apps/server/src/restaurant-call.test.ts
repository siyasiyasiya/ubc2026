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

  it("without a phone number, makes a talk-to link and finds the conversation it started", async () => {
    const { fetchFn, calls } = fakeFetch([]);
    const caller = new ElevenLabsRestaurantCaller({ apiKey: "k", agentId: "agent_1", fetch: fetchFn });
    const { callId, link } = await caller.start(request);
    expect(calls).toHaveLength(0);
    const url = new URL(link!);
    expect(url.origin + url.pathname).toBe("https://elevenlabs.io/app/talk-to");
    expect(url.searchParams.get("agent_id")).toBe("agent_1");
    expect(url.searchParams.get("var_restaurant")).toBe("Uchi");
    expect(url.searchParams.get("var_party_size")).toBe("4");
    const ref = url.searchParams.get("var_call_ref")!;

    const conv = (id: string, callRef: string) => ({ body: { conversation_id: id, conversation_initiation_client_data: { dynamic_variables: { call_ref: callRef } } } });
    const responses = [
      { body: { conversations: [] } }, // nobody has tapped yet
      { body: { conversations: [{ conversation_id: "conv_other" }, { conversation_id: "conv_mine" }] } },
      conv("conv_other", "someone-else"),
      conv("conv_mine", ref),
      { body: { status: "done", analysis: { data_collection_results: { reservation_confirmed: { value: false }, alternative_offered: { value: "8:30" } } } } },
    ];
    const second = fakeFetch(responses);
    const reader = new ElevenLabsRestaurantCaller({ apiKey: "k", agentId: "agent_1", fetch: second.fetchFn });
    expect(await reader.result(callId)).toEqual({ status: "in_progress" });
    expect(await reader.result(callId)).toEqual({ status: "done", booked: false, alternative: "8:30" });
    expect(second.calls[0]!.url).toContain("/v1/convai/conversations?agent_id=agent_1&call_start_after_unix=");
    expect(second.calls.at(-1)!.url).toBe("https://api.elevenlabs.io/v1/convai/conversations/conv_mine");
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
