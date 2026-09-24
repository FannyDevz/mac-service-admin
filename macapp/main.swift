// Service Admin.app: peluncur ringan. Memastikan server jalan, membuka dashboard
// http://127.0.0.1:8765 di browser default, lalu keluar (tanpa jendela sendiri).
// Dibangun oleh ../install.sh dengan: swiftc -O main.swift -framework Cocoa
//
// Urutan menyalakan server: LaunchAgent `local.service-admin` (dipasang install.sh),
// lalu fallback menjalankan `python3 server.py` langsung dari folder project.
import Cocoa

let PORT = 8765
let BASE = URL(string: "http://127.0.0.1:\(PORT)/")!
let AGENT = "local.service-admin"

func serverUp() -> Bool {
    var req = URLRequest(url: BASE.appendingPathComponent("api/jobs"))
    req.timeoutInterval = 1.5
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    URLSession.shared.dataTask(with: req) { _, resp, _ in
        ok = (resp as? HTTPURLResponse)?.statusCode == 200
        sem.signal()
    }.resume()
    sem.wait()
    return ok
}

@discardableResult
func run(_ path: String, _ args: [String]) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return -1 }
    p.waitUntilExit()
    return p.terminationStatus
}

func shellQuote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

func startServer() {
    // 1) LaunchAgent
    if run("/bin/launchctl", ["kickstart", "gui/\(getuid())/\(AGENT)"]) == 0 { return }
    // 2) jalankan langsung; nohup + & agar server tetap hidup setelah peluncur ini keluar
    let info = Bundle.main.infoDictionary ?? [:]
    guard let dir = info["SAProjectDir"] as? String else { return }
    let python = (info["SAPython"] as? String) ?? "/usr/bin/python3"
    let logs = NSHomeDirectory() + "/.service-admin/logs"
    try? FileManager.default.createDirectory(atPath: logs, withIntermediateDirectories: true)
    run("/bin/sh", ["-c", "cd \(shellQuote(dir)) && nohup \(shellQuote(python)) server.py >>\(shellQuote(logs + "/server.log")) 2>>\(shellQuote(logs + "/server.err")) &"])
}

func waitForServer(seconds: Double) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    repeat {
        if serverUp() { return true }
        Thread.sleep(forTimeInterval: 0.25)
    } while Date() < end
    return false
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)  // tanpa ikon Dock yang tertinggal

var ready = serverUp()
if !ready {
    startServer()
    ready = waitForServer(seconds: 12)
}
if ready {
    NSWorkspace.shared.open(BASE)
} else {
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.messageText = "Server Service Admin belum siap"
    alert.informativeText = """
    Kalau muncul dialog “Python ingin mengakses file di folder Dokumen”, klik Izinkan, lalu buka Service Admin lagi.
    Tidak ada dialog? Buka System Settings → Privacy & Security → Files & Folders → Python → Documents.

    Log: ~/.service-admin/logs/server.err
    """
    alert.addButton(withTitle: "Tetap buka di browser")
    alert.addButton(withTitle: "Tutup")
    if alert.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(BASE) }
}
exit(0)
