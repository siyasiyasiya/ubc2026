# Kitty's booking-call voice agent (ElevenLabs)

Kitty phones a business (a canoe rental, a tour, a restaurant) to book for the group with an ElevenLabs voice agent, and asks for the total so the group can split it. The server (`apps/server/src/booking-call.ts`) starts each call and reads the result. The agent itself is set up once in the ElevenLabs dashboard, as below.

## 1. Phone number

ElevenLabs places the call through a phone number connected to it. The documented path is a Twilio number: in **ElevenAgents → Phone Numbers → Import**, give the number, a label, and a Twilio API key SID and secret (or Account SID and Auth Token). The id ElevenLabs shows for it is `ELEVENLABS_PHONE_NUMBER_ID`.

A Twilio trial account can only call numbers you have verified in Twilio. Newer accounts, even upgraded ones, can't buy a number or place calls until a business profile (with an EIN) is approved in Trust Hub.

**Real calls from a Mac, no phone line** (what our demo runs): set `KITTY_CALL_BRIDGE=1` and `KITTY_CALL_PAGE_URL=http://localhost:5199/call.html`. `scripts/call-bridge/dial.sh` dials through the Mac's paired iPhone and opens the call page in Chrome, which runs the agent with Kitty's voice going into the call through BlackHole 16ch (`brew install --cask blackhole-16ch`) and Kitty listening through the laptop mic. Keep the room quiet, no headphones plugged in, and click the call page when the other person picks up.

**No phone number?** Leave `ELEVENLABS_PHONE_NUMBER_ID` empty. Kitty then texts the restaurant's number an iMessage link to Kitty's incoming-call page (`https://kittyagent.vercel.app/call.html?agent_id=…&var_restaurant=…&var_call_ref=…`, in `apps/onboard`). Tapping Accept starts the same conversation in their browser with `@elevenlabs/client`. ElevenLabs' own talk-to page reads the same params, so `KITTY_CALL_PAGE_URL=https://elevenlabs.io/app/talk-to` is a fallback. This needs the agent's authentication off (Advanced tab; the default for new agents).

## 2. Agent

Create an agent in **ElevenAgents**. Its id is `ELEVENLABS_AGENT_ID`.

**First message**

```
Hi! I'm Kitty, an AI assistant calling on behalf of a group called {{group}}. I'd like to book {{booking}}, is now a good time?
```

**System prompt**

```
You are Kitty, an AI assistant phoning {{business}} to book something for a group of friends called {{group}}.
Say you're an AI assistant if asked, and never pretend to be a person.

The booking:
- What: {{booking}}
- People: {{party_size}}
- When: {{when}}
- Name for the booking: {{reservation_name}}
- Notes to mention if relevant: {{notes}}

Be brief, warm and polite. Ask for the booking at that time, then ask what the total price comes to
(including any tax or fees) and how they'd like to be paid; the group pays at pickup unless they need
something else. If that time isn't available, ask for the closest time they can offer, but do not
accept a different time yourself: say you'll check with the group and call back. If they need a card
or a deposit over the phone, say the group will follow up, and end politely.
Confirm the details and the total back once before ending the call. If you reach voicemail, leave no
message and hang up.
Staff often pause or say "um" while they check the schedule: wait quietly. Don't fill silences or ask
if they're still there.
```

The `{{…}}` names are dynamic variables. The server fills them for each call (`conversation_initiation_client_data.dynamic_variables`). Variables: `business`, `booking`, `party_size`, `when`, `reservation_name`, `notes`, `group`. Also add a `call_ref` placeholder (any value): calls started from the call page carry it so the server can find their conversation.

**Turn taking** (Advanced): eagerness **Patient**, speculative turn **off**, turn timeout **15 s**. With the defaults Kitty jumped in on every "um" and asked "are you still there?" after a short pause.

**Analysis → Data collection** (exact names; the server reads these)

| Name | Type | Description |
| --- | --- | --- |
| `booking_confirmed` | boolean | True only if the business confirmed the booking for the requested group during this call. |
| `confirmed_time` | string | The time the business confirmed, written short with digits, like "Sat 9am" or "9:30am". Empty if nothing was confirmed. |
| `alternative_offered` | string | The closest other time the business offered if the requested time wasn't available, written short with digits, like "10am". Empty if none. |
| `total_price_usd` | number | The total price the business quoted for the whole booking, in US dollars, as a plain number (e.g. 240 or 239.50). Use the full total including tax and fees if they said it. Empty if no price was given. |

## 3. Server

In `apps/server/.env` (see `.env.example`):

```
ELEVENLABS_API_KEY=...
ELEVENLABS_AGENT_ID=...
ELEVENLABS_PHONE_NUMBER_ID=...   # optional: a Twilio line
KITTY_CALL_BRIDGE=1              # optional: real calls from this Mac instead (see above)
KITTY_CALL_PAGE_URL=http://localhost:5199/call.html
```

On start the server logs `calls: ElevenLabs voice agent, …` with how calls go out. In the group chat: "kitty book 3 canoes for 2 hours at Lakeside Canoe Rentals, (518) 817-3144, saturday 9am". When the call ends Kitty posts the booking and, if a price was quoted, proposes the split on the trip's tab; otherwise the time they offered instead, or that nobody picked up.
