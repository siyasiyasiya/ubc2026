# Kitty's restaurant-calling voice agent (ElevenLabs)

Kitty phones restaurants with an ElevenLabs voice agent. The server (`apps/server/src/restaurant-call.ts`) starts each call and reads the result. The agent itself is set up once in the ElevenLabs dashboard, as below.

## 1. Phone number

ElevenLabs places the call through a phone number connected to it. The documented path is a Twilio number: in **ElevenAgents → Phone Numbers → Import**, give the number, a label, and a Twilio API key SID and secret (or Account SID and Auth Token). The id ElevenLabs shows for it is `ELEVENLABS_PHONE_NUMBER_ID`.

A Twilio trial account can only call numbers you have verified in Twilio. Newer trial accounts can't claim a number at all until upgraded.

**No phone number?** Leave `ELEVENLABS_PHONE_NUMBER_ID` empty. Kitty then texts the restaurant's number an iMessage link to Kitty's incoming-call page (`https://kittyagent.vercel.app/call.html?agent_id=…&var_restaurant=…&var_call_ref=…`, in `apps/onboard`). Tapping Accept starts the same conversation in their browser with `@elevenlabs/client`. ElevenLabs' own talk-to page reads the same params, so `KITTY_CALL_PAGE_URL=https://elevenlabs.io/app/talk-to` is a fallback. This needs the agent's authentication off (Advanced tab; the default for new agents).

## 2. Agent

Create an agent in **ElevenAgents**. Its id is `ELEVENLABS_AGENT_ID`.

**First message**

```
Hi! I'm Kitty, an AI assistant calling on behalf of a group called {{group}}. I'd like to book a table, is now a good time?
```

**System prompt**

```
You are Kitty, an AI assistant phoning {{restaurant}} to book a table for a group of friends called {{group}}.
Say you're an AI assistant if asked, and never pretend to be a person.

The booking:
- Party size: {{party_size}}
- When: {{when}}
- Name for the reservation: {{reservation_name}}
- Notes to mention if relevant: {{notes}}

Be brief, warm and polite. Ask for the table at that time. If it isn't available, ask what the closest
time they can offer is, but do not accept a different time yourself: say you'll check with the group
and call back. If they need a phone number or deposit, say the group will follow up and end politely.
Confirm the details back once before ending the call. If you reach voicemail, leave no message and hang up.
Staff often pause or say "um" while they check the book: wait quietly. Don't fill silences or ask if they're still there.
```

The `{{…}}` names are dynamic variables. The server fills them for each call (`conversation_initiation_client_data.dynamic_variables`). Also add a `call_ref` placeholder (any value): link calls carry it so the server can find their conversation.

**Turn taking** (Advanced): eagerness **Patient**, speculative turn **off**, turn timeout **15 s**. With the defaults Kitty jumped in on every "um" and asked "are you still there?" after a short pause.

**Analysis → Data collection** (exact names; the server reads these)

| Name | Type | Description |
| --- | --- | --- |
| `reservation_confirmed` | boolean | True only if the restaurant confirmed a reservation for the requested party during this call. |
| `confirmed_time` | string | The time the restaurant confirmed, written short with digits, like "7:30pm" or "Fri 8pm". Empty if nothing was confirmed. |
| `alternative_offered` | string | The closest other time the restaurant offered if the requested time wasn't available, written short with digits, like "8:30pm". Empty if none. |

## 3. Server

In `apps/server/.env` (see `.env.example`):

```
ELEVENLABS_API_KEY=...
ELEVENLABS_AGENT_ID=...
ELEVENLABS_PHONE_NUMBER_ID=...   # optional: without it, calls go by link
```

On start the server logs `calls: ElevenLabs voice agent, phone calls` (or `…, texts the restaurant a link to talk`). In the group chat: "kitty, book Uchi for 4 tomorrow at 7:30, their number is (512) 555-0100". Kitty posts "📞 calling…" and, when the call ends, the result: booked with the confirmed time, the alternative they offered, or that nobody picked up.
