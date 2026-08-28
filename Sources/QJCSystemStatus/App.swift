import AppKit
import Darwin
import Foundation
import SwiftUI

enum QJCColor {
    static let pink = Color(red: 0.925, green: 0.424, blue: 0.612)
    static let indigo = Color(red: 0.129, green: 0.247, blue: 0.584)
    static let navy = Color(red: 0.102, green: 0.118, blue: 0.235)
    static let ink = Color(red: 0.055, green: 0.059, blue: 0.071)
}

enum AppLanguage: String, CaseIterable {
    case korean = "ko"
    case english = "en"
    case japanese = "ja"
    case simplifiedChinese = "zh-Hans"
    case traditionalChinese = "zh-Hant"
    case spanish = "es"
    case french = "fr"
    case german = "de"

    static func detect(locale: Locale) -> AppLanguage {
        let language = locale.language.languageCode?.identifier ?? "en"
        if language == "zh" {
            let script = locale.language.script?.identifier
            return script == "Hant" || locale.region?.identifier == "TW" || locale.region?.identifier == "HK" ? .traditionalChinese : .simplifiedChinese
        }
        return AppLanguage(rawValue: language) ?? .english
    }

    static var current: AppLanguage { detect(locale: .current) }
}

enum L10n {
    private static let language = AppLanguage.current
    private static let values: [String: [AppLanguage: String]] = [
        "systemStatus": [.korean: "SYSTEM STATUS", .english: "SYSTEM STATUS", .japanese: "SYSTEM STATUS", .simplifiedChinese: "SYSTEM STATUS", .traditionalChinese: "SYSTEM STATUS", .spanish: "SYSTEM STATUS", .french: "SYSTEM STATUS", .german: "SYSTEM STATUS"],
        "headline": [.korean: "지금, 컴퓨터는 어떤가요?", .english: "How is your computer right now?", .japanese: "今、コンピュータの状態は？", .simplifiedChinese: "现在，电脑状态如何？", .traditionalChinese: "現在，電腦狀態如何？", .spanish: "¿Cómo está tu ordenador ahora?", .french: "Comment va votre ordinateur ?", .german: "Wie geht es deinem Computer?"],
        "local": [.korean: "로컬에서만 측정", .english: "Measured locally only", .japanese: "ローカルのみで測定", .simplifiedChinese: "仅在本地测量", .traditionalChinese: "僅在本機測量", .spanish: "Medido solo localmente", .french: "Mesuré localement uniquement", .german: "Nur lokal gemessen"],
        "updated": [.korean: "마지막 업데이트", .english: "Last updated", .japanese: "最終更新", .simplifiedChinese: "最后更新", .traditionalChinese: "最後更新", .spanish: "Última actualización", .french: "Dernière mise à jour", .german: "Zuletzt aktualisiert"],
        "cpuSubtitle": [.korean: "프로세서 사용량", .english: "Processor usage", .japanese: "プロセッサ使用量", .simplifiedChinese: "处理器使用率", .traditionalChinese: "處理器使用率", .spanish: "Uso del procesador", .french: "Utilisation du processeur", .german: "Prozessorauslastung"],
        "ramSubtitle": [.korean: "메모리 사용량", .english: "Memory usage", .japanese: "メモリ使用量", .simplifiedChinese: "内存使用率", .traditionalChinese: "記憶體使用率", .spanish: "Uso de memoria", .french: "Utilisation de la mémoire", .german: "Speichernutzung"],
        "diskSubtitle": [.korean: "하드 디스크 사용량", .english: "Disk usage", .japanese: "ディスク使用量", .simplifiedChinese: "磁盘使用率", .traditionalChinese: "磁碟使用率", .spanish: "Uso del disco", .french: "Utilisation du disque", .german: "Festplattennutzung"],
        "cpuDetail": [.korean: "전체 코어 평균", .english: "Average across all cores", .japanese: "全コア平均", .simplifiedChinese: "所有核心平均", .traditionalChinese: "所有核心平均", .spanish: "Promedio de todos los núcleos", .french: "Moyenne de tous les cœurs", .german: "Durchschnitt aller Kerne"],
        "unavailable": [.korean: "읽을 수 없음", .english: "Unavailable", .japanese: "読み取れません", .simplifiedChinese: "无法读取", .traditionalChinese: "無法讀取", .spanish: "No disponible", .french: "Indisponible", .german: "Nicht verfügbar"],
        "diskUnavailable": [.korean: "사용 불가", .english: "Unavailable", .japanese: "利用不可", .simplifiedChinese: "不可用", .traditionalChinese: "無法使用", .spanish: "No disponible", .french: "Indisponible", .german: "Nicht verfügbar"],
        "refresh": [.korean: "새로고침", .english: "Refresh", .japanese: "更新", .simplifiedChinese: "刷新", .traditionalChinese: "重新整理", .spanish: "Actualizar", .french: "Actualiser", .german: "Aktualisieren"],
        "quit": [.korean: "종료", .english: "Quit", .japanese: "終了", .simplifiedChinese: "退出", .traditionalChinese: "結束", .spanish: "Salir", .french: "Quitter", .german: "Beenden"],
        "stable": [.korean: "안정적", .english: "Stable", .japanese: "安定", .simplifiedChinese: "稳定", .traditionalChinese: "穩定", .spanish: "Estable", .french: "Stable", .german: "Stabil"],
        "watch": [.korean: "살펴보기", .english: "Watch", .japanese: "注意", .simplifiedChinese: "注意", .traditionalChinese: "注意", .spanish: "Vigilar", .french: "À surveiller", .german: "Beobachten"],
        "critical": [.korean: "정리 필요", .english: "Needs attention", .japanese: "要注意", .simplifiedChinese: "需要处理", .traditionalChinese: "需要處理", .spanish: "Requiere atención", .french: "À traiter", .german: "Aufmerksamkeit nötig"]
    ]

    static func text(_ key: String, language: AppLanguage = language) -> String { values[key]?[language] ?? values[key]?[.english] ?? key }
}

struct MemoryMetric: Equatable, Sendable {
    let usedBytes: UInt64
    let totalBytes: UInt64
    var fraction: Double { guard totalBytes > 0 else { return 0 }; return Double(usedBytes) / Double(totalBytes) }
}

struct DiskMetric: Equatable, Sendable {
    let usedBytes: UInt64
    let totalBytes: UInt64
    var fraction: Double { guard totalBytes > 0 else { return 0 }; return Double(usedBytes) / Double(totalBytes) }
}

enum MetricStatus: String, Equatable, Sendable {
    case normal, watch, critical
    var title: String {
        switch self { case .normal: return L10n.text("stable"); case .watch: return L10n.text("watch"); case .critical: return L10n.text("critical") }
    }
    var color: Color {
        switch self {
        case .normal: return QJCColor.indigo
        case .watch: return QJCColor.pink
        case .critical: return Color(red: 0.95, green: 0.35, blue: 0.3)
        }
    }
}

enum MetricValue {
    static func percent(_ fraction: Double) -> Double { min(max(fraction, 0), 1) * 100 }
    static func status(for fraction: Double) -> MetricStatus {
        switch fraction { case 0.85...: return .critical; case 0.65..<0.85: return .watch; default: return .normal }
    }
}

enum ByteFormatter {
    static func string(bytes: UInt64) -> String {
        let units = ["B", "KB", "MB", "GB", "TB"]
        var value = Double(bytes)
        var index = 0
        while value >= 1024 && index < units.count - 1 { value /= 1024; index += 1 }
        if index == 0 { return "\(Int(value)) B" }
        if index == 2 && value.rounded() == value { return String(format: "%.0f %@", value, units[index]) }
        return String(format: "%.1f %@", value, units[index])
    }
}

struct SystemSnapshot: Equatable, Sendable {
    let cpu: Double?
    let memory: MemoryMetric?
    let disk: DiskMetric?
    let capturedAt: Date
    var displayCPU: String { cpu.map { "\(Int(MetricValue.percent($0).rounded()))%" } ?? "—" }
    var displayMemory: String {
        guard let memory else { return "—" }
        return "\(Int(MetricValue.percent(memory.fraction).rounded()))%"
    }
    var displayDisk: String {
        guard let disk else { return L10n.text("diskUnavailable") }
        return "\(Int(MetricValue.percent(disk.fraction).rounded()))%"
    }
}

@MainActor
final class SystemMetricsStore: ObservableObject {
    @Published private(set) var snapshot = SystemSnapshot(cpu: nil, memory: nil, disk: nil, capturedAt: .now)
    private let collector = SystemMetricsCollector()
    private var timer: Timer?

    init() {
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }
    func refresh() { snapshot = collector.snapshot() }
}

final class SystemMetricsCollector: @unchecked Sendable {
    private var previousTicks: (active: UInt64, total: UInt64)?

    func snapshot() -> SystemSnapshot { SystemSnapshot(cpu: cpuUsage(), memory: memoryUsage(), disk: diskUsage(), capturedAt: .now) }

    private func cpuUsage() -> Double? {
        var info = host_cpu_load_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<host_cpu_load_info_data_t>.stride / MemoryLayout<integer_t>.stride)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, $0, &count) }
        }
        guard result == KERN_SUCCESS else { return nil }
        let user = UInt64(info.cpu_ticks.0), system = UInt64(info.cpu_ticks.1), idle = UInt64(info.cpu_ticks.2), nice = UInt64(info.cpu_ticks.3)
        let active = user + system + nice, total = active + idle
        defer { previousTicks = (active, total) }
        guard let previous = previousTicks else { return nil }
        let totalDelta = total >= previous.total ? total - previous.total : 0
        let activeDelta = active >= previous.active ? active - previous.active : 0
        guard totalDelta > 0 else { return nil }
        return min(max(Double(activeDelta) / Double(totalDelta), 0), 1)
    }

    private func memoryUsage() -> MemoryMetric? {
        let total = UInt64(ProcessInfo.processInfo.physicalMemory)
        var stats = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.stride / MemoryLayout<integer_t>.stride)
        let result = withUnsafeMutablePointer(to: &stats) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count) }
        }
        guard result == KERN_SUCCESS else { return nil }
        var pageSize: vm_size_t = 0
        guard host_page_size(mach_host_self(), &pageSize) == KERN_SUCCESS else { return nil }
        let usedPages = UInt64(stats.active_count + stats.wire_count + stats.compressor_page_count)
        return MemoryMetric(usedBytes: min(usedPages * UInt64(pageSize), total), totalBytes: total)
    }

    private func diskUsage() -> DiskMetric? {
        guard let attributes = try? FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory()),
              let total = (attributes[.systemSize] as? NSNumber)?.uint64Value,
              let free = (attributes[.systemFreeSize] as? NSNumber)?.uint64Value,
              total > 0, free <= total else { return nil }
        return DiskMetric(usedBytes: total - free, totalBytes: total)
    }
}

struct MetricCard: View {
    let label: String
    let subtitle: String
    let value: String
    let detail: String
    let fraction: Double?
    let icon: String
    let tint: Color
    private var status: MetricStatus { MetricValue.status(for: fraction ?? 0) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: icon).font(.system(size: 14, weight: .bold)).foregroundStyle(tint).frame(width: 30, height: 30).background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 2) {
                    Text(label.uppercased()).font(.system(size: 11, weight: .bold, design: .rounded)).tracking(1.2).foregroundStyle(.white.opacity(0.75))
                    Text(subtitle).font(.system(size: 11, weight: .medium, design: .rounded)).foregroundStyle(.white.opacity(0.42))
                }
                Spacer()
                Text(value).font(.system(size: 24, weight: .bold, design: .rounded)).foregroundStyle(.white)
            }
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.1))
                    Capsule().fill(LinearGradient(colors: [tint, tint.opacity(0.58)], startPoint: .leading, endPoint: .trailing)).frame(width: max(6, geometry.size.width * min(max(fraction ?? 0, 0), 1)))
                }
            }.frame(height: 7)
            HStack {
                Text(detail).font(.system(size: 11, weight: .medium, design: .rounded)).foregroundStyle(.white.opacity(0.5))
                Spacer()
                Text(status.title).font(.system(size: 10, weight: .bold, design: .rounded)).foregroundStyle(status.color)
            }
        }
        .padding(16)
        .background(Color.white.opacity(0.065), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(.white.opacity(0.08), lineWidth: 1))
    }
}

struct QJCLogo: View {
    var body: some View {
        Group {
            if let url = Bundle.main.resourceURL?.appendingPathComponent("QJCSystemStatus_QJCSystemStatus.bundle/qjc-logo-white.png"),
               let image = NSImage(contentsOf: url) {
                Image(nsImage: image).resizable().scaledToFit()
            } else {
                Text("QJC").font(.system(size: 13, weight: .black, design: .rounded)).tracking(1.2)
            }
        }
        .frame(width: 42, height: 20)
        .accessibilityLabel("QJC")
    }
}

struct DashboardView: View {
    @ObservedObject var store: SystemMetricsStore
    private var snapshot: SystemSnapshot { store.snapshot }
    private var timeText: String { snapshot.capturedAt.formatted(date: .omitted, time: .shortened) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 8) {
                            QJCLogo()
                            Text(L10n.text("systemStatus")).font(.system(size: 11, weight: .bold, design: .rounded)).tracking(1.4).foregroundStyle(QJCColor.pink)
                        }
                        Text(L10n.text("headline")).font(.system(size: 20, weight: .bold, design: .rounded)).foregroundStyle(.white)
                    }
                    Spacer()
                    Circle().fill(QJCColor.indigo).frame(width: 34, height: 34).overlay(Image(systemName: "waveform.path.ecg").font(.system(size: 14, weight: .bold)).foregroundStyle(.white))
                }
                HStack(spacing: 7) {
                    Circle().fill(QJCColor.pink).frame(width: 7, height: 7)
                    Text("\(L10n.text("local")) · \(L10n.text("updated")) \(timeText)").font(.system(size: 11, weight: .medium, design: .rounded)).foregroundStyle(.white.opacity(0.48))
                }
            }
            .padding(18)
            .background(LinearGradient(colors: [QJCColor.navy, QJCColor.ink], startPoint: .topLeading, endPoint: .bottomTrailing))
            VStack(spacing: 12) {
                MetricCard(label: "CPU", subtitle: L10n.text("cpuSubtitle"), value: snapshot.displayCPU, detail: L10n.text("cpuDetail"), fraction: snapshot.cpu, icon: "cpu", tint: QJCColor.indigo)
                MetricCard(label: "RAM", subtitle: L10n.text("ramSubtitle"), value: snapshot.displayMemory, detail: memoryDetail, fraction: snapshot.memory?.fraction, icon: "memorychip", tint: QJCColor.pink)
                MetricCard(label: "DISK", subtitle: L10n.text("diskSubtitle"), value: snapshot.displayDisk, detail: diskDetail, fraction: snapshot.disk?.fraction, icon: "internaldrive", tint: Color(red: 0.45, green: 0.62, blue: 1))
            }.padding(.horizontal, 18).padding(.bottom, 18)
            HStack {
                Text(L10n.text("systemStatus")).font(.system(size: 10, weight: .bold, design: .rounded)).tracking(1.1).foregroundStyle(.white.opacity(0.35))
                Spacer()
                Button(L10n.text("refresh")) { store.refresh() }.buttonStyle(.plain).font(.system(size: 11, weight: .bold, design: .rounded)).foregroundStyle(QJCColor.pink)
                Button(L10n.text("quit")) { NSApplication.shared.terminate(nil) }.buttonStyle(.plain).font(.system(size: 11, weight: .bold, design: .rounded)).foregroundStyle(.white.opacity(0.4))
            }.padding(.horizontal, 18).padding(.vertical, 14).background(.black.opacity(0.16))
        }
        .frame(width: 360)
        .background(QJCColor.ink)
        .preferredColorScheme(.dark)
    }

    private var memoryDetail: String {
        guard let memory = snapshot.memory else { return L10n.text("unavailable") }
        return "\(ByteFormatter.string(bytes: memory.usedBytes)) / \(ByteFormatter.string(bytes: memory.totalBytes))"
    }
    private var diskDetail: String {
        guard let disk = snapshot.disk else { return L10n.text("unavailable") }
        return "\(ByteFormatter.string(bytes: disk.usedBytes)) / \(ByteFormatter.string(bytes: disk.totalBytes))"
    }
}

enum SelfTest {
    static func run() {
        precondition(MetricValue.percent(1.2) == 100)
        precondition(MetricValue.percent(-0.2) == 0)
        precondition(MetricValue.status(for: 0.42) == .normal)
        precondition(MetricValue.status(for: 0.72) == .watch)
        precondition(MetricValue.status(for: 0.92) == .critical)
        precondition(ByteFormatter.string(bytes: 512 * 1024 * 1024) == "512 MB")
        precondition(ByteFormatter.string(bytes: 2 * 1024 * 1024 * 1024) == "2.0 GB")
        let fallback = SystemSnapshot(cpu: nil, memory: nil, disk: nil, capturedAt: .now)
        precondition(fallback.displayCPU == "—")
        precondition(fallback.displayMemory == "—")
        precondition(fallback.displayDisk == L10n.text("diskUnavailable"))
        for language in AppLanguage.allCases { precondition(!L10n.text("headline", language: language).isEmpty) }
        precondition(AppLanguage.detect(locale: Locale(identifier: "ko_KR")) == .korean)
        precondition(AppLanguage.detect(locale: Locale(identifier: "ja_JP")) == .japanese)
        precondition(AppLanguage.detect(locale: Locale(identifier: "zh_TW")) == .traditionalChinese)
        precondition(AppLanguage.detect(locale: Locale(identifier: "pt_BR")) == .english)
        print("SELF-TEST PASS: metric clamps, thresholds, byte formatting, and disk fallback")
    }
}

struct QJCSystemStatusApp: App {
    @StateObject private var store = SystemMetricsStore()
    init() {
        if CommandLine.arguments.contains("--self-test") { SelfTest.run(); exit(0) }
        if CommandLine.arguments.contains("--dump-ui-text"),
           let argument = CommandLine.arguments.first(where: { $0.hasPrefix("--locale=") }) {
            let localeID = String(argument.dropFirst("--locale=".count))
            let selected = AppLanguage.detect(locale: Locale(identifier: localeID))
            print("LANGUAGE \(selected.rawValue): \(L10n.text("headline", language: selected))")
            print("CPU / RAM / DISK: \(L10n.text("cpuSubtitle", language: selected)) / \(L10n.text("ramSubtitle", language: selected)) / \(L10n.text("diskSubtitle", language: selected))")
            exit(0)
        }
    }
    var body: some Scene {
        MenuBarExtra { DashboardView(store: store) } label: {
            HStack(spacing: 5) {
                Circle().fill(QJCColor.pink).frame(width: 6, height: 6)
                Text("CPU \(store.snapshot.displayCPU) · RAM \(store.snapshot.displayMemory) · SSD \(store.snapshot.displayDisk)").font(.system(size: 11, weight: .semibold, design: .rounded))
            }
        }.menuBarExtraStyle(.window)
    }
}
