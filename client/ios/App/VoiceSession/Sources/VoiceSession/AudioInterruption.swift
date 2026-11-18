import AVFAudio

enum AudioInterruption {
    static func shouldResume(_ info: [AnyHashable: Any]?) -> Bool {
        guard let type = info?[AVAudioSessionInterruptionTypeKey] as? UInt,
              AVAudioSession.InterruptionType(rawValue: type) == .ended,
              let options = info?[AVAudioSessionInterruptionOptionKey] as? UInt else { return false }
        return AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume)
    }
}
