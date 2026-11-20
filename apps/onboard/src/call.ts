// The "incoming call" page Kitty texts to a business when the bot has no phone line (no paid Twilio
// number). It reads the same params the ElevenLabs talk-to link uses: `agent_id` plus `var_<name>`
// dynamic variables (including `call_ref`, which the server uses to find this conversation and post
// the result). Accept starts the same voice agent in the browser over WebRTC.
import { Conversation } from "@elevenlabs/client";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const params = new URLSearchParams(location.search);
const agentId = params.get("agent_id");
const variables: Record<string, string> = {};
for (const [key, value] of params) if (key.startsWith("var_")) variables[key.slice(4)] = value;

const status = $("status");
const captions = $("captions");
const subject = variables.restaurant ?? variables.business;
$("sub").textContent = variables.group ? `AI assistant for ${variables.group}` : "AI assistant";
if (subject) document.title = `Kitty is calling about ${subject}`;

type State = "ringing" | "connecting" | "listening" | "speaking" | "ended";
function setState(state: State) {
  document.body.dataset.state = state;
  $("ringing-controls").hidden = state !== "ringing";
  $("call-controls").hidden = state === "ringing" || state === "ended";
}

let conversation: Conversation | undefined;
let startedAt = 0;
let timer: number | undefined;
let ring: { stop(): void; resume(): void } | undefined;

function clock(): string {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function caption(role: "agent" | "user", text: string) {
  const p = document.createElement("p");
  p.className = `line ${role}`;
  const who = document.createElement("b");
  who.textContent = role === "agent" ? "Kitty" : "You";
  p.append(who, text);
  captions.append(p);
  while (captions.children.length > 6) captions.firstElementChild?.remove();
}

function ended(text: string) {
  ring?.stop();
  if (timer) clearInterval(timer);
  setState("ended");
  status.textContent = startedAt ? `${text} · ${clock()}` : text;
}

/** A soft two-tone ring. Browsers only allow sound after a tap, so this is best effort until one happens. */
function startRing(): { stop(): void; resume(): void } | undefined {
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);
    for (const freq of [440, 480]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start();
    }
    let t = ctx.currentTime;
    const schedule = () => {
      for (let i = 0; i < 4; i++, t += 6) {
        gain.gain.setValueAtTime(0.08, t);
        gain.gain.setValueAtTime(0, t + 2);
      }
    };
    schedule();
    const again = setInterval(schedule, 20_000);
    return { stop: () => { clearInterval(again); void ctx.close(); }, resume: () => void ctx.resume() };
  } catch {
    return undefined;
  }
}

async function accept() {
  ring?.stop();
  if (!agentId) return ended("this call link is incomplete");
  setState("connecting");
  status.textContent = "connecting…";
  try {
    conversation = await Conversation.startSession({
      agentId,
      connectionType: "webrtc",
      dynamicVariables: variables,
      onConnect: () => {
        startedAt = Date.now();
        status.textContent = "0:00";
        timer = window.setInterval(() => { status.textContent = clock(); }, 1000);
      },
      onModeChange: ({ mode }) => setState(mode === "speaking" ? "speaking" : "listening"),
      onMessage: ({ role, message }) => caption(role, message),
      onDisconnect: (details) => ended(details.reason === "error" ? "call failed" : "call ended"),
      onError: (message) => console.error("call error:", message),
    });
  } catch (err) {
    console.error(err);
    ended(err instanceof DOMException && err.name === "NotAllowedError" ? "allow the microphone to answer" : "couldn't connect");
  }
}

$("accept").addEventListener("click", () => void accept());
$("decline").addEventListener("click", () => ended("call declined"));
$("hangup").addEventListener("click", () => {
  if (conversation) void conversation.endSession();
  else ended("call ended");
});
$("mute").addEventListener("click", (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  const muted = btn.getAttribute("aria-pressed") !== "true";
  btn.setAttribute("aria-pressed", String(muted));
  conversation?.setMicMuted(muted);
});

setState("ringing");
ring = startRing();
// Sound is usually blocked until a tap; the first tap anywhere starts the ring while it's still ringing.
document.addEventListener("pointerdown", () => { if (document.body.dataset.state === "ringing") ring?.resume(); }, { once: true });
