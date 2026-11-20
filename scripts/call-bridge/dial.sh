#!/bin/zsh
# Places a real phone call from this Mac (through the paired iPhone, "Calls from iPhone") with Kitty's
# ElevenLabs voice agent on the line. Audio path (BlackHole virtual device, see make-devices.swift):
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
SwitchAudioSource -t output -s "MacBook Pro Speakers" >/dev/null
SwitchAudioSource -t input -s "BlackHole 16ch" >/dev/null

# Bridge params: Kitty listens on the Mac's mic, speaks into "Kitty out", starts once the callee talks.
sep='?'; [[ "$page" == *\?* ]] && sep='&'
open -a "Google Chrome" "${page}${sep}mic=MacBook%20Pro%20Microphone&speaker=BlackHole%2016ch&answer=auto"
open "tel://${phone}"
echo "calling $phone with Kitty on the line (restore audio after: $0 --restore)"
