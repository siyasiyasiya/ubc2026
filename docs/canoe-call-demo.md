# Canoe call demo (scene 4): Siya's Mac calls Neena's iPhone

Kitty, running on **Siya's Mac**, places a **real phone call** through Siya's iPhone to **Neena's iPhone (614) 800-1324**. Neena plays **Lakeside Canoe Rentals**, on camera. The ElevenLabs voice agent talks; Kitty posts the booking and the split in the group.

**Two rooms.** Kitty listens to the call through Siya's Mac mic, so Neena must be out of earshot of Siya's Mac.

---

## Siya (Mac + bot)

### Setup (once, ~20 min; details in `docs/handoff-siya.md` §3)
1. `git pull --rebase --autostash && npx -y pnpm@9.15.0 install && npx -y pnpm@9.15.0 build`
2. Audio: `brew install --cask blackhole-16ch`, `brew install switchaudio-osx`, `sudo killall coreaudiod`. Check that `SwitchAudioSource -a` lists **BlackHole 16ch**.
3. Calls from iPhone: on the iPhone, Settings → Apps → Phone → **Calls on Other Devices** → this Mac. On the Mac, FaceTime → Settings → **Calls from iPhone** ✓.
4. **Test:** `open tel://+16148001324`. Neena's phone should ring. Hang up.
5. Call page, in its own terminal, left running: `cd apps/onboard && ./node_modules/.bin/vite --port 5199 --strictPort`. Uses Chrome; allow the mic the first time.
6. `apps/server/.env` (copy values from Neena's `.env`):
   ```
   TREASURY_ADDRESS=0x8e55291277d4D282dC4a1c00132fcdE610e06BdC
   TREASURY_DEPLOY_BLOCK=73182149
   ELEVENLABS_API_KEY=<from Neena>
   ELEVENLABS_AGENT_ID=<from Neena>
   KITTY_CALL_BRIDGE=1
   KITTY_CALL_PAGE_URL=http://localhost:5199/call.html
   KITTY_EVENTS_URL=https://kittyagent.vercel.app/api/events
   EVENTS_SECRET=<from Neena>
   ```
   Leave `ELEVENLABS_PHONE_NUMBER_ID` empty.
7. **No headphones** connected (the script refuses to dial with headphones). Room quiet.
8. Restart the bot. The log should say `calls: ElevenLabs voice agent, real phone calls from this Mac (KITTY_CALL_BRIDGE)`.

### Rehearsal (simulator, no iMessage)
```bash
cd apps/server && npx tsx --env-file=.env src/sim.ts
```
Type:
```
siya: canoe trip saturday, all 3 of us in. kitty book 3 canoes for 2 hours at Lakeside Canoe Rentals, (614) 800-1324, saturday 9am, under siya
```
If Kitty asks for the trip plan: `siya: one time trip, 200 each`. Neena's phone rings; do the call (below). Afterwards: `/like neena 1`, `/like joey 1` (use the request number shown).

### Filming (the real take, from the group chat)
1. **Screen-record Siya's iPhone** (Control Center → Screen Recording, **mic on**) and send a **voice memo** in the group:
   *"Kitty, book us three canoes for two hours at Lakeside Canoe Rentals, Saturday at 9am, under Siya."* Then type: **"their number's (614) 800-1324"**.
2. **QuickTime → New Screen Recording** on the Mac, with sound, showing the **Kitty call page** in Chrome.
3. The Mac dials Neena. Chrome shows "ringing… (click when they answer)". **Click the Kitty page the moment Neena says hello.**
4. Let Kitty talk. Don't touch anything or speak; the Mac mic is listening.
5. After Kitty says goodbye: the group shows **"booked ✅ 3 canoes Sat 9am, $250 total"** and the 🧾 split. Keep the phone screen recording on for it.
6. Afterwards: `scripts/call-bridge/dial.sh --restore` puts the Mac's audio back.

**If it goes wrong:** stuck on "ringing…": click the Kitty page. Neena hears nothing: the macOS call bar is muted, or the input isn't BlackHole (`SwitchAudioSource -c -t input`). Kitty mishears: room too loud or headphones connected.

---

## Neena (the canoe shop, on camera)

### Setup
- **Another room**, quiet, good light on your face. A prop helps: a "Lakeside Canoe Rentals" sign or a clipboard.
- **Camera:** a second phone (or a teammate filming) on a stand, landscape, facing you, recording video with sound. Your iPhone sits **face-up on the table in frame**, so the incoming call is visible.
- Your iPhone: ringer on, Do Not Disturb **off** (it has to ring), volume up.

### The take
1. Start the camera. **Clap once** (to line up clips in the edit).
2. Your phone rings from Siya's iPhone number. Pick it up and **put it on speaker**, so the camera records Kitty's voice.
3. Say: **"Lakeside Canoe, hello?"**
4. Kitty: *"Hi! I'm Kitty, an AI assistant calling on behalf of … I'd like to book 3 canoes for 2 hours, Saturday at 9am…"*
5. You: **"Saturday at 9 works. That'll be $250 total."** Pause after each sentence; Kitty waits for you to finish.
6. If Kitty asks for a name or to confirm: **"Got it, under Siya. See you Saturday."**
7. Let Kitty say goodbye and hang up. Stop the camera after a beat.

**Tip:** do one rehearsal call first (Siya's simulator run) so both of you know the timing.

---

## In the edit
- Open on Siya's voice memo, then cut to Neena's phone ringing on the table and Neena answering, then a split-screen of Neena's face and the Mac's Kitty call page for the conversation, then the group chat result and the 👍s.
- Line up the camera and the Mac recording with the clap.
- **VO:** "Some things need a phone call. Kitty heard that voice memo with ElevenLabs Speech-to-Text, then made a real phone call with an ElevenLabs voice agent. It said it's an AI, booked the canoes, asked for the price, and turned that price straight into a split on the trip's tab."
