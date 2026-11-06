import SwiftUI
import Supabase

// The creator's own TikTok and Instagram, by handle, as in Settings on
// chumoku.co. Public view counts are all this reads, so there is no login.
nonisolated struct SocialAccount: Decodable, Identifiable, Hashable {
    let platform: String
    let handle: String
    var id: String { platform }
}

nonisolated struct SocialVideo: Decodable, Identifiable, Hashable {
    let videoId: String
    let platform: String
    let title: String?
    let views: Int?
    let url: String?
    var id: String { videoId }

    enum CodingKeys: String, CodingKey {
        case title, views, url, platform
        case videoId = "video_id"
    }

    // Hashtags say nothing about what the video was.
    var shownTitle: String {
        let words = (title ?? "").split(separator: " ").filter { !$0.hasPrefix("#") }
        return words.isEmpty ? String(localized: "Untitled") : words.joined(separator: " ")
    }
}

struct SocialSection: View {
    @Environment(AuthModel.self) private var auth
    @Environment(\.openURL) private var openURL
    @State private var accounts: [SocialAccount]?
    @State private var videos: [SocialVideo] = []
    @State private var inputs: [String: String] = [:]
    @State private var busy: String?
    @State private var error: String?

    private let platforms = [("tiktok", "TikTok", "@name"), ("instagram", "Instagram", "@name")]

    var body: some View {
        VStack(spacing: 0) {
            if let accounts {
                ForEach(platforms, id: \.0) { platform, label, hint in
                    if let account = accounts.first(where: { $0.platform == platform }) {
                        connected(account, label: label)
                    } else {
                        field(platform, label: label, hint: hint)
                    }
                    Rectangle().fill(Color.line).frame(height: 1).padding(.leading, 16)
                }
                if let error {
                    Text(error).font(.tSmall).foregroundStyle(Color.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                }
            } else {
                Skeleton(cornerRadius: 10).frame(height: 44).padding(16)
            }
        }
        .task { await load() }
    }

    private func connected(_ account: SocialAccount, label: String) -> some View {
        VStack(spacing: 8) {
            HStack(spacing: 12) {
                Text(verbatim: "\(label) · @\(account.handle)").font(.tBody).foregroundStyle(Color.text).lineLimit(1)
                Spacer()
                Button { Task { await send(["action": "remove", "platform": account.platform], key: account.platform) } } label: {
                    if busy == account.platform { ProgressView().controlSize(.small) }
                    else { Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(Color.textFaint) }
                }
                .buttonStyle(.plain)
                .frame(width: 32, height: 32)
                .accessibilityLabel("Remove \(account.handle)")
            }
            ForEach(videos.filter { $0.platform == account.platform }.prefix(3)) { v in
                Button { if let u = v.url.flatMap(URL.init(string:)) { openURL(u) } } label: {
                    HStack(spacing: 12) {
                        Text(v.shownTitle).font(.tSmall).foregroundStyle(Color.textMuted).lineLimit(1)
                        Spacer()
                        Text((v.views ?? 0).formatted(.number.notation(.compactName)))
                            .font(.tSmall).foregroundStyle(Color.textMuted).monospacedDigit()
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
    }

    private func field(_ platform: String, label: String, hint: String) -> some View {
        let value = (inputs[platform] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return HStack(spacing: 8) {
            Text(verbatim: label).font(.tBody).foregroundStyle(Color.text)
            TextField("", text: Binding(get: { inputs[platform] ?? "" }, set: { inputs[platform] = $0 }),
                      prompt: Text(verbatim: hint).foregroundStyle(Color.textFaint))
                .font(.tBody).foregroundStyle(Color.text)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .submitLabel(.done)
                .accessibilityLabel("Your \(label)")
            Button { Task { await send(["action": "add", "platform": platform, "input": value], key: platform) } } label: {
                if busy == platform { ProgressView().controlSize(.small) } else { Text("Add").font(.geist(14, .medium)) }
            }
            .buttonStyle(.plain)
            .foregroundStyle(value.isEmpty ? Color.textFaint : Color.text)
            .disabled(busy != nil || value.isEmpty)
        }
        .padding(16)
    }

    private func load() async {
        #if DEBUG
        if IdeasStore.isDemo { accounts = []; return }
        #endif
        guard let uid = auth.user?.id else { accounts = []; return }
        let a: [SocialAccount] = (try? await supabase.from("social_accounts")
            .select("platform, handle").eq("user_id", value: uid).execute().value) ?? []
        videos = (try? await supabase.from("social_videos")
            .select("video_id, platform, title, views, url").eq("user_id", value: uid)
            .order("views", ascending: false).limit(60).execute().value) ?? []
        accounts = a
    }

    private func send(_ body: [String: String], key: String) async {
        guard busy == nil else { return }
        busy = key
        error = nil
        defer { busy = nil }
        nonisolated struct Failed: Decodable { let error: String? }
        nonisolated struct Done: Decodable { let success: Bool? }
        do {
            let _: Done = try await supabase.functions.invoke("sync-social", options: FunctionInvokeOptions(body: body))
            inputs[key] = nil
            await load()
        } catch let FunctionsError.httpError(_, data) {
            error = (try? JSONDecoder().decode(Failed.self, from: data))?.error ?? String(localized: "Something went wrong.")
        } catch {
            self.error = String(localized: "Something went wrong.")
        }
    }
}
