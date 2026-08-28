// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "QJCSystemStatus",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "QJCSystemStatus", targets: ["QJCSystemStatus"])
    ],
    targets: [
        .executableTarget(name: "QJCSystemStatus", resources: [.process("Resources")])
    ]
)
