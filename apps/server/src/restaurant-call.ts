/**
 * Kitty phones a restaurant with an ElevenLabs voice agent (Agents Platform, outbound via a Twilio
 * number connected to ElevenLabs), then reads back how the call went.
 *
 *   start:  POST /v1/convai/twilio/outbound-call   { agent_id, agent_phone_number_id, to_number,
 *                                                    conversation_initiation_client_data.dynamic_variables }
 *   result: GET  /v1/convai/conversations/{id}      status initiated | in-progress | processing | done | failed
 *           analysis.data_collection_results.{reservation_confirmed, confirmed_time, alternative_offered}
 *           analysis.transcript_summary, metadata.phone_call.call_result (answered | voicemail | busy | no_answer | failed)
 *
 * The agent itself (voice, the prompt that says it's an AI calling for a group, and the data
 * collection fields above) is set up once in the ElevenLabs dashboard; see docs/elevenlabs-agent.md.
 */

export interface RestaurantCallRequest {
  restaurant: string;
  /** E.164, e.g. +15551234567. */
  phone: string;
  partySize: number;
  /** As the group said it, e.g. "tomorrow at 7:30pm". */
  when: string;
  /** Name the reservation goes under. */
  reservationName: string;
  notes?: string;
  /** The group chat's name, so the agent can say who it's calling for. */
  group: string;
}

export interface RestaurantCallResult {
  status: "in_progress" | "done" | "failed";
  /** answered | voicemail | busy | no_answer | failed, when the phone system reports it. */
  pickedUp?: string;
  booked?: boolean;
  confirmedTime?: string;
  alternative?: string;
  summary?: string;
  error?: string;
}

/** Places restaurant calls. ElevenLabs in production; a fake in tests. */
export interface RestaurantCaller {
  start(request: RestaurantCallRequest): Promise<{ callId: string }>;
  result(callId: string): Promise<RestaurantCallResult>;
}

export interface ElevenLabsConfig {
  apiKey: string;
  agentId: string;
  /** The phone_number_id ElevenLabs returned when the Twilio number was connected. */
  phoneNumberId: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

type Json = Record<string, unknown>;

export class ElevenLabsRestaurantCaller implements RestaurantCaller {
  private readonly base: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly config: ElevenLabsConfig) {
    this.base = config.baseUrl ?? "https://api.elevenlabs.io";
    this.fetch = config.fetch ?? fetch;
  }

  async start(request: RestaurantCallRequest): Promise<{ callId: string }> {
    const body = await this.call("POST", "/v1/convai/twilio/outbound-call", {
      agent_id: this.config.agentId,
      agent_phone_number_id: this.config.phoneNumberId,
      to_number: request.phone,
      conversation_initiation_client_data: {
        dynamic_variables: {
          restaurant: request.restaurant,
          party_size: request.partySize,
          when: request.when,
          reservation_name: request.reservationName,
          notes: request.notes ?? "none",
          group: request.group,
        },
      },
    });
    const id = typeof body.conversation_id === "string" ? body.conversation_id : undefined;
    if (body.success === false || !id) throw new Error(String(body.message ?? "the call didn't start"));
    return { callId: id };
  }

  async result(callId: string): Promise<RestaurantCallResult> {
    const body = await this.call("GET", `/v1/convai/conversations/${encodeURIComponent(callId)}`);
    const status = String(body.status ?? "");
    const metadata = (body.metadata ?? {}) as Json;
    const phoneCall = (metadata.phone_call ?? {}) as Json;
    const pickedUp = typeof phoneCall.call_result === "string" ? phoneCall.call_result : undefined;
    if (status === "failed") {
      const error = (metadata.error ?? {}) as Json;
      return { status: "failed", ...(pickedUp ? { pickedUp } : {}), error: String(error.reason ?? "the call failed") };
    }
    const analysis = body.analysis as Json | null | undefined;
    // "done" with analysis is final; analysis can lag a moment behind the status.
    if (status !== "done" || !analysis) return { status: "in_progress" };
    const data = (analysis.data_collection_results ?? {}) as Record<string, { value?: unknown }>;
    const value = (key: string) => data[key]?.value;
    const text = (key: string) => {
      const v = value(key);
      return typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim() : undefined;
    };
    const booked = value("reservation_confirmed");
    const confirmedTime = text("confirmed_time");
    const alternative = text("alternative_offered");
    const summary = typeof analysis.transcript_summary === "string" ? analysis.transcript_summary : undefined;
    return {
      status: "done",
      ...(pickedUp ? { pickedUp } : {}),
      ...(typeof booked === "boolean" ? { booked } : {}),
      ...(confirmedTime ? { confirmedTime } : {}),
      ...(alternative ? { alternative } : {}),
      ...(summary ? { summary } : {}),
    };
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<Json> {
    const res = await this.fetch(`${this.base}${path}`, {
      method,
      headers: { "xi-api-key": this.config.apiKey, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      const detail = (json.detail ?? json.message ?? res.statusText) as unknown;
      throw new Error(`ElevenLabs ${res.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    }
    return json;
  }
}

/** ElevenLabs settings from the environment, or undefined when calling isn't set up. */
export function elevenLabsFromEnv(env: NodeJS.ProcessEnv = process.env): ElevenLabsRestaurantCaller | undefined {
  const apiKey = env.ELEVENLABS_API_KEY;
  const agentId = env.ELEVENLABS_AGENT_ID;
  const phoneNumberId = env.ELEVENLABS_PHONE_NUMBER_ID;
  if (!apiKey || !agentId || !phoneNumberId) return undefined;
  return new ElevenLabsRestaurantCaller({ apiKey, agentId, phoneNumberId });
}
