// Creates the two Multi-Output devices the phone-call bridge uses, so the room hears both sides:
//   "Kitty out" = BlackHole 16ch + the Mac's speakers  (Kitty's voice → the call's mic, and the room)
//   "Call out"  = BlackHole 2ch  + the Mac's speakers  (the caller's voice → Kitty's mic, and the room)
// Run: swift scripts/call-bridge/make-devices.swift   (safe to rerun; skips devices that exist)
import CoreAudio
import Foundation

func deviceIDs() -> [AudioDeviceID] {
  var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size)
  var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids)
  return ids
}

func string(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String {
  var addr = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr, let v = value else { return "" }
  return v.takeRetainedValue() as String
}

let devices = deviceIDs().map { (name: string($0, kAudioObjectPropertyName), uid: string($0, kAudioDevicePropertyDeviceUID)) }
func uid(named name: String) -> String {
  guard let d = devices.first(where: { $0.name.contains(name) }) else {
    print("missing audio device \"\(name)\". Have: \(devices.map(\.name).joined(separator: ", "))")
    exit(1)
  }
  return d.uid
}

let speakers = uid(named: "MacBook Pro Speakers")
for (name, bridge) in [("Kitty out", "BlackHole 16ch"), ("Call out", "BlackHole 2ch")] {
  if devices.contains(where: { $0.name == name }) { print("\(name): already there"); continue }
  let desc: [String: Any] = [
    kAudioAggregateDeviceNameKey: name,
    kAudioAggregateDeviceUIDKey: "kitty.\(name.replacingOccurrences(of: " ", with: "-").lowercased())",
    kAudioAggregateDeviceIsStackedKey: 1, // stacked = Multi-Output: every sub-device plays the same audio
    kAudioAggregateDeviceMainSubDeviceKey: speakers,
    kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: speakers], [kAudioSubDeviceUIDKey: uid(named: bridge)]],
  ]
  var id: AudioDeviceID = 0
  let status = AudioHardwareCreateAggregateDevice(desc as CFDictionary, &id)
  print(status == noErr ? "\(name): created (\(bridge) + speakers)" : "\(name): failed (\(status))")
}
// Aggregates made this way can vanish when the process exits unless macOS persists them; keep it alive briefly.
RunLoop.main.run(until: Date().addingTimeInterval(1))
