// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "VoiceSession",
    platforms: [.iOS(.v15)],
    products: [.library(name: "VoiceSession", targets: ["VoiceSession"])],
    targets: [
        .target(name: "VoiceSession"),
        .testTarget(name: "VoiceSessionTests", dependencies: ["VoiceSession"])
    ]
)
