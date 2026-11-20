#!/bin/zsh
# Places a real phone call from this Mac (through the paired iPhone, "Calls from iPhone") with Kitty's
# ElevenLabs voice agent on the line. Needs: brew install --cask blackhole-16ch; brew install switchaudio-osx.
#   caller's voice: the call plays on the MacBook speakers (macOS ignores virtual outputs for calls), so the
#                   room hears it, and Kitty listens with the MacBook microphone (needs a quiet room)
#   Kitty's voice:  Kitty → BlackHole 16ch only (on the speakers, the mic would hear Kitty) → call
# Usage: dial.sh +15125550100 '<call page URL with agent_id and var_… params>'
# Restore normal audio afterwards: dial.sh --restore
set -euo pipefail
STATE="${TMPDIR:-/tmp}/kitty-call-bridge.audio"

if [[ "${1:-}" == "--restore" ]]; then
  if [[ -f "$STATE" ]]; then
    IFS=$'\n' read -r -d '' out in < "$STATE" || true
    SwitchAudioSource -t output -s "$out" >/dev/null
    SwitchAudioSource -t input -s "$in" >/dev/null
    rm -f "$STATE"
  fi
  echo "audio back to: $(SwitchAudioSource -t output -c) / $(SwitchAudioSource -t input -c)"
  exit 0
fi

phone="$1"; page="$2"
[[ "$phone" == +* ]] || { echo "phone must be E.164, like +15125550100"; exit 1; }
# A phone call grabs plugged-in headphones over the default output, so the caller would never reach Kitty.
if SwitchAudioSource -a -t output | grep -qiE 'earpods|airpods|headphones|beats'; then
  echo "unplug or disconnect headphones first: the call would play into them instead of to Kitty"; exit 1
fi

# Remember the normal devices once (a second call shouldn't save the bridge as "normal").
[[ -f "$STATE" ]] || printf '%s\n%s\n' "$(SwitchAudioSource -t output -c)" "$(SwitchAudioSource -t input -c)" > "$STATE"
# The Mac's own speakers and mic (e.g. "MacBook Pro Speakers", "MacBook Air Microphone", "Mac mini Speakers").
builtin_out=$(SwitchAudioSource -a -t output | grep -m1 -E '^(MacBook|Mac mini|iMac|Mac Studio|Built-in).*(Speakers|Output)' || true)
builtin_in=$(SwitchAudioSource -a -t input | grep -m1 -E '^(MacBook|iMac|Mac Studio|Built-in).*(Microphone|Input)' || true)
[[ -n "$builtin_out" && -n "$builtin_in" ]] || { echo "couldn't find the Mac's built-in speakers/mic: $(SwitchAudioSource -a | tr '\n' ',')"; exit 1; }
SwitchAudioSource -t output -s "$builtin_out" >/dev/null
SwitchAudioSource -t input -s "BlackHole 16ch" >/dev/null

# Bridge params: Kitty listens on the Mac's mic, speaks into BlackHole 16ch, starts once the callee talks (or a click).
sep='?'; [[ "$page" == *\?* ]] && sep='&'
mic=${builtin_in// /%20}
open -a "Google Chrome" "${page}${sep}mic=${mic}&speaker=BlackHole%2016ch&answer=auto"
open "tel://${phone}"
echo "calling $phone with Kitty on the line (restore audio after: $0 --restore)"
