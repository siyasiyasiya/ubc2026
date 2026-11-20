// The "incoming call" page Kitty texts to a business when the bot has no phone line (no paid Twilio
// number). It reads the same params the ElevenLabs talk-to link uses: `agent_id` plus `var_<name>`
// dynamic variables (including `call_ref`, which the server uses to find this conversation and post
// the result). Accept starts the same voice agent in the browser over WebRTC.
import { Conversation } from "@elevenlabs/client";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const params = new URLSearchParams(location.search);
// Bridge mode (real phone call through the Mac): `mic` and `speaker` name the audio devices to use, by
// part of their label (e.g. mic=MacBook Pro Microphone hears the call on the speakers, speaker=BlackHole 16ch sends Kitty's
// voice into the call). `answer=auto` skips the ring and starts Kitty once the callee speaks or someone clicks.
const micLabel = params.get("mic");
const speakerLabel = params.get("speaker");
const autoAnswer = params.get("answer") === "auto";
const monitorLabel = params.get("monitor");
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

/** The device ids for `mic` / `speaker` labels. Labels are only visible after mic permission. */
async function pickDevices(): Promise<{ inputDeviceId?: string; outputDeviceId?: string }> {
  if (!micLabel && !speakerLabel) return {};
  const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
  probe.getTracks().forEach((t) => t.stop());
  const devices = await navigator.mediaDevices.enumerateDevices();
  const find = (kind: MediaDeviceKind, label: string | null) => {
    if (!label) return undefined;
    const d = devices.find((x) => x.kind === kind && x.label.toLowerCase().includes(label.toLowerCase()));
    if (!d) throw new Error(`no ${kind} named "${label}" (have: ${devices.filter((x) => x.kind === kind).map((x) => x.label).join(", ")})`);
    return d.deviceId;
  };
  const inputDeviceId = find("audioinput", micLabel);
  const outputDeviceId = find("audiooutput", speakerLabel);
  return { ...(inputDeviceId ? { inputDeviceId } : {}), ...(outputDeviceId ? { outputDeviceId } : {}) };
}

/**
 * Plays the bridge's input (the caller) on another output, e.g. the laptop speakers, so the room hears both
 * sides. Phone calls on a Mac skip multi-output devices, so the call itself can only go to BlackHole.
 */
async function monitor(inputDeviceId: string, outputLabel: string): Promise<void> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const out = devices.find((d) => d.kind === "audiooutput" && d.label.toLowerCase().includes(outputLabel.toLowerCase()));
  if (!out) return console.warn(`no output named "${outputLabel}" to play the caller on`);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: inputDeviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const audio = new Audio();
  audio.srcObject = stream;
  await (audio as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(out.deviceId);
  await audio.play();
}

/** Resolves when the input device carries speech-level sound for a moment (the callee saying "hello?"). */
async function heardVoice(deviceId: string): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let loudFor = 0;
  try {
    await new Promise<void>((resolve) => {
      const tick = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const v of samples) sum += v * v;
        loudFor = Math.sqrt(sum / samples.length) > 0.02 ? loudFor + 1 : 0;
        if (loudFor >= 3) { // ~150ms of sound
          clearInterval(tick);
          resolve();
        }
      }, 50);
    });
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  }
}

async function accept() {
  ring?.stop();
  if (!agentId) return ended("this call link is incomplete");
  setState("connecting");
  status.textContent = "connecting…";
  try {
    const devices = await pickDevices();
    if (devices.inputDeviceId && monitorLabel) await monitor(devices.inputDeviceId, monitorLabel);
    if (autoAnswer && devices.inputDeviceId) {
      // A real phone call is ringing on the other end: start Kitty only once someone picks up and talks.
      status.textContent = "ringing… (click when they answer)";
      // Whichever comes first: their voice, or whoever runs the call clicking / pressing a key when they pick up.
      await Promise.race([
        heardVoice(devices.inputDeviceId),
        new Promise<void>((resolve) => {
          document.addEventListener("pointerdown", () => resolve(), { once: true });
          document.addEventListener("keydown", () => resolve(), { once: true });
        }),
      ]);
      status.textContent = "connecting…";
    }
    conversation = await Conversation.startSession({
      agentId,
      ...devices,
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
    ended(err instanceof DOMException && err.name === "NotAllowedError" ? "allow the microphone to answer" : err instanceof Error && err.message.startsWith("no ") ? err.message : "couldn't connect");
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
if (autoAnswer) void accept();
else ring = startRing();
// Sound is usually blocked until a tap; the first tap anywhere starts the ring while it's still ringing.
document.addEventListener("pointerdown", () => { if (document.body.dataset.state === "ringing") ring?.resume(); }, { once: true });
