import SwiftUI
import Supabase

// The first minutes after signing up (2026-10-30). One question, connect
// YouTube, because the brain reads level, niche and voice off the uploads
// better than anyone describes them. Then their own Shorts appear while the
// brain is read, which is the moment it shows it is about them, and the first
// ideas are already theirs. No plans here: those come up when credits do.
// The web runs the same three steps (src/components/Onboarding.tsx).
struct OnboardingView: View {
    let onDone: () -> Void

    @Environment(AuthModel.self) private var auth
    @Environment(\.webAuthenticationSession) private var webAuth
    private enum Step { case connect, describe, reading, ready }
    @State private var step: Step = .connect
    @State private var about = ""
    @State private var connecting = false
    @State private var error: String?
    @State private var thumbs: [String] = []
    @State private var summary: String?
    @State private var finishing = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch step {
            case .connect: connect
            case .describe: describe
            case .reading: reading
            case .ready: ready
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.bg.ignoresSafeArea())
        .animation(.ui, value: step)
    }

    // MARK: steps

    private var connect: some View {
        VStack(alignment: .leading, spacing: 0) {
            Image("Mark").resizable().scaledToFit().frame(width: 44, height: 44).padding(.top, 72)
            Text("Connect your YouTube").font(.tTitle).foregroundStyle(Color.text).padding(.top, 28)
            Text("Chumoku reads your Shorts and picks every idea for your channel. Read-only, nothing is ever posted.")
                .font(.tBody).foregroundStyle(Color.textMuted).padding(.top, 12)
                .fixedSize(horizontal: false, vertical: true)
            if let error { Text(error).font(.tSmall).foregroundStyle(Color.danger).padding(.top, 16) }
            Spacer()
            Button { Task { await connectYouTube() } } label: {
                HStack(spacing: 8) {
                    if connecting { ProgressView().controlSize(.small).tint(Color.bg) }
                    Text("Connect YouTube")
                }
            }
            .buttonStyle(.pill)
            .disabled(connecting)
            Button("I don't have a channel yet") { error = nil; step = .describe; focused = true }
                .font(.geist(14, .medium)).foregroundStyle(Color.textMuted)
                .frame(maxWidth: .infinity).padding(.vertical, 14)
                .buttonStyle(.plain)
        }
    }

    private var describe: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { step = .connect } label: {
                Image(systemName: "chevron.left").font(.system(size: 17, weight: .semibold)).foregroundStyle(Color.text)
                    .frame(width: 44, height: 44, alignment: .leading)
            }
            .buttonStyle(.plain)
            .padding(.top, 16)
            Text("What do you make?").font(.tTitle).foregroundStyle(Color.text).padding(.top, 28)
            TextField("Cooking Shorts for students, gym tips, my startup...", text: $about, axis: .vertical)
                .font(.tBody).foregroundStyle(Color.text)
                .lineLimit(3...6)
                .focused($focused)
                .padding(16)
                .background(RoundedRectangle(cornerRadius: Radius.sm, style: .continuous).fill(Color.raised))
                .overlay(RoundedRectangle(cornerRadius: Radius.sm, style: .continuous).strokeBorder(Color.line, lineWidth: 1))
                .padding(.top, 20)
            Text("A sentence is enough.").font(.tSmall).foregroundStyle(Color.textFaint).padding(.top, 10)
            Spacer()
            Button("Continue") { Task { await saveAbout() } }
                .buttonStyle(.pill)
                .disabled(about.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private var reading: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Reading your channel").font(.tTitle).foregroundStyle(Color.text).padding(.top, 72)
            Working(label: thumbs.isEmpty ? "Looking at your Shorts" : "Working out what works for you")
                .padding(.top, 12)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 3), spacing: 8) {
                ForEach(thumbs, id: \.self) { url in
                    AsyncImage(url: URL(string: url)) { img in img.resizable().scaledToFill() } placeholder: { Color.white.opacity(0.06) }
                        .frame(maxWidth: .infinity)
                        .aspectRatio(9 / 16, contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .transition(.scale(scale: 0.9).combined(with: .opacity))
                }
            }
            .padding(.top, 28)
            Spacer()
        }
    }

    private var ready: some View {
        VStack(alignment: .leading, spacing: 0) {
            Image("Mark").resizable().scaledToFit().frame(width: 44, height: 44).padding(.top, 72)
            Text("Got it").font(.tTitle).foregroundStyle(Color.text).padding(.top, 28)
            if let summary {
                Text(summary).font(.tBody).foregroundStyle(Color.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(16)
                    .background(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).fill(Color.raised))
                    .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Color.line, lineWidth: 1))
                    .padding(.top, 20)
                Text("Every idea and script is written against this. Change it any time in Settings.")
                    .font(.tSmall).foregroundStyle(Color.textFaint).padding(.top, 10)
            }
            Spacer()
            Button { Task { await finish() } } label: {
                HStack(spacing: 8) {
                    if finishing { ProgressView().controlSize(.small).tint(Color.bg) }
                    Text("Continue")
                }
            }
            .buttonStyle(.pill)
            .disabled(finishing)
        }
    }

    // MARK: work

    private func connectYouTube() async {
        guard let uid = auth.user?.id else { return }
        connecting = true
        error = nil
        defer { connecting = false }
        switch await YouTubeConnect.run(webAuth, user: uid) {
        case .connected: await read()
        case .failed: error = String(localized: "Could not connect that account. Try again.")
        case .cancelled: break
        }
    }

    private func saveAbout() async {
        guard let uid = auth.user?.id else { return }
        nonisolated struct Patch: Encodable { let channel_description: String }
        focused = false
        _ = try? await supabase.from("user_tokens")
            .update(Patch(channel_description: about.trimmingCharacters(in: .whitespacesAndNewlines)))
            .eq("user_id", value: uid).execute()
        await read()
    }

    // The brain is built while their Shorts fill in: build-brain saves the
    // channel scan before the model starts writing, so polling the scan shows
    // the thumbnails within a few seconds.
    private func read() async {
        nonisolated struct Built: Decodable { let brain: Brain? }
        step = .reading
        let poll = Task { await pollThumbs() }
        let built: Built? = try? await supabase.functions.invoke("build-brain", options: FunctionInvokeOptions(body: ["force": true]))
        poll.cancel()
        await loadThumbs()
        // Long enough to see their Shorts land when the build was quick.
        if !thumbs.isEmpty { try? await Task.sleep(for: .seconds(1.2)) }
        summary = built?.brain?.summary
        step = .ready
    }

    private func pollThumbs() async {
        while !Task.isCancelled {
            await loadThumbs()
            try? await Task.sleep(for: .seconds(1.5))
        }
    }

    private func loadThumbs() async {
        nonisolated struct Scan: Decodable {
            nonisolated struct Video: Decodable { let id: String? }
            let videos: [Video]?
        }
        nonisolated struct Row: Decodable { let channel_scan: Scan? }
        guard let uid = auth.user?.id else { return }
        let row: Row? = try? await supabase.from("user_tokens").select("channel_scan").eq("user_id", value: uid).single().execute().value
        let urls = (row?.channel_scan?.videos ?? []).compactMap(\.id).prefix(9).map { "https://i.ytimg.com/vi/\($0)/hqdefault.jpg" }
        // One at a time, so they arrive rather than appear.
        for url in urls where !thumbs.contains(url) {
            withAnimation(.ui) { thumbs.append(url) }
            try? await Task.sleep(for: .milliseconds(140))
        }
    }

    private func finish() async {
        guard let uid = auth.user?.id else { return }
        nonisolated struct Patch: Encodable { let onboarding_completed = true }
        finishing = true
        _ = try? await supabase.from("user_tokens").update(Patch()).eq("user_id", value: uid).execute()
        await Reminders.askOnce()
        finishing = false
        onDone()
    }
}
