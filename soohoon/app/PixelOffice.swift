// 픽셀 오피스 데스크톱 창 — localhost:8000 을 항상 위에 떠 있는 작은 창으로 띄운다.
// 빌드: bash build-app.sh  →  ~/Applications/Pixel Office.app
import Cocoa
import WebKit

let officeURL = URL(string: "http://localhost:8000/")!
let officeSh = NSString(string: "~/.claude/skills/pixel-office/office.sh").expandingTildeInPath

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var pinItem: NSMenuItem!
    var retry: Timer?
    var titleObs: NSKeyValueObservation?

    var pinned: Bool {
        get { UserDefaults.standard.object(forKey: "pinned") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "pinned") }
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        web.navigationDelegate = self
        web.uiDelegate = self  // 없으면 confirm()/alert() 가 조용히 '취소'가 된다
        // 페이지 제목이 "(N) Pixel Office" 면 확인 필요 N 개 — Dock 아이콘 배지로
        titleObs = web.observe(\.title, options: [.new]) { w, _ in
            let t = w.title ?? ""
            var badge: String? = nil
            if t.hasPrefix("("), let end = t.firstIndex(of: ")"),
               let n = Int(t[t.index(after: t.startIndex)..<end]), n > 0 {
                badge = String(n)
            }
            DispatchQueue.main.async { NSApp.dockTile.badgeLabel = badge }
        }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 360),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Pixel Office"
        window.contentView = web
        window.isReleasedWhenClosed = false
        // 모든 데스크톱(Space)·전체화면 앱 위에서도 보이게
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        // 저장된 위치가 지금 연결된 화면 밖이면(외부 모니터 분리 등) 가운데로
        let restored = window.setFrameUsingName("PixelOfficeWindow")
        if !restored || !NSScreen.screens.contains(where: { $0.visibleFrame.intersects(window.frame) }) {
            window.setContentSize(NSSize(width: 480, height: 360))
            window.center()
        }
        window.setFrameAutosaveName("PixelOfficeWindow")
        applyPin()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        startServerIfNeeded()
        web.load(URLRequest(url: officeURL))
    }

    // 창을 닫아도 Dock 아이콘을 누르면 다시 열린다
    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    func startServerIfNeeded() {
        var req = URLRequest(url: officeURL); req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            if resp != nil { return }
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/bash")
            p.arguments = ["-lc", "\"\(officeSh)\" start"]
            try? p.run()
        }.resume()
    }

    // 서버가 아직 안 떠 있으면 2초마다 다시 시도
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
        retry?.invalidate()
        retry = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
            self?.web.load(URLRequest(url: officeURL))
        }
    }

    // 외부 링크는 기본 브라우저로
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = a.request.url, u.host != "localhost", u.host != "127.0.0.1",
           a.navigationType == .linkActivated {
            NSWorkspace.shared.open(u); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }

    // 페이지의 alert / confirm 을 macOS 대화상자로
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "확인")
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message
        a.addButton(withTitle: "확인"); a.addButton(withTitle: "취소")  // 범용 confirm() — 설정 저장 안 함 경고 등
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
    }

    func applyPin() {
        window.level = pinned ? .floating : .normal
        pinItem?.state = pinned ? .on : .off
    }

    @objc func togglePin() { pinned.toggle(); applyPin() }
    @objc func reload() { web.load(URLRequest(url: officeURL)) }
    @objc func openInBrowser() { NSWorkspace.shared.open(officeURL) }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Pixel Office 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        // 채팅창 입력에 복사·붙여넣기가 되려면 Edit 메뉴가 있어야 한다
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "편집")
        edit.addItem(withTitle: "실행 취소", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "잘라내기", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "복사", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "붙여넣기", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "모두 선택", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "보기")
        pinItem = view.addItem(withTitle: "항상 위에", action: #selector(togglePin), keyEquivalent: "t")
        view.addItem(withTitle: "새로고침", action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: "브라우저에서 열기", action: #selector(openInBrowser), keyEquivalent: "o")
        viewItem.submenu = view
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
