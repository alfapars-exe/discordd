import AVFAudio
import XCTest
@testable import VoiceSession

final class AudioInterruptionTests: XCTestCase {
    func testOnlyEndedWithResumeHintReactivates() {
        let ended = AVAudioSession.InterruptionType.ended.rawValue
        let began = AVAudioSession.InterruptionType.began.rawValue
        let resume = AVAudioSession.InterruptionOptions.shouldResume.rawValue
        XCTAssertFalse(AudioInterruption.shouldResume(nil))
        XCTAssertFalse(AudioInterruption.shouldResume([AVAudioSessionInterruptionTypeKey: ended]))
        for (type, options, expected) in [(began, resume, false), (ended, 0, false), (ended, resume, true)] {
            let info = [AVAudioSessionInterruptionTypeKey: NSNumber(value: type),
                        AVAudioSessionInterruptionOptionKey: NSNumber(value: options)]
            XCTAssertEqual(AudioInterruption.shouldResume(info), expected)
        }
    }
}
