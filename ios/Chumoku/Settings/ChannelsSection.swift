import SwiftUI
import Supabase

// Competitor channels, the same list as Settings on chumoku.co: channels you
// follow, whose best Shorts land in your daily ideas. Add by link, remove with
// a swipe-free x. The drop also finds channels on its own, so this is one
// source of several.
nonisolated struct CompetitorChannel: Decodable, Identifiable, Hashable {
    let id: String
    let channelId: String
    let channelName: String?
    let channelTitle: String?
    let channelThumbnail: String?
    let thumbnailUrl: String?

    enum CodingKeys: String, CodingKey {
        case id
        case channelId = "channel_id"
        case channelName = "channel_name"
        case channelTitle = "channel_title"
        case channelThumbnail = "channel_thumbnail"
        case thumbnailUrl = "thumbnail_url"
    }

    // The table carries both spellings of these two columns.
    var name: String { channelName ?? channelTitle ?? channelId }
    var thumb: URL? { (channelThumbnail ?? thumbnailUrl).flatMap(URL.init(string:)) }
}

struct ChannelsSection: View {
    @Environment(AuthModel.self) private var auth
    let plan: String?
    @State private var channels: [CompetitorChannel]?
    @State private var link = ""
    @State private var adding = false
    @State private var removing: String?
    @State private var error: String?

    private var limit: Int { plan == "agency" ? 10 : (plan ?? "free") == "free" ? 3 : 5 }

    var body: some View {
        VStack(spacing: 0) {
            if let channels {
                ForEach(channels) { c in
                    HStack(spacing: 12) {
                        AsyncImage(url: c.thumb) { img in img.resizable().scaledToFill() } placeholder: { Color.white.opacity(0.08) }
                            .frame(width: 32, height: 32).clipShape(Circle())
                        Text(c.name).font(.tBody).foregroundStyle(Color.text).lineLimit(1)
                        Spacer()
                        Button { Task { await remove(c) } } label: {
                            if removing == c.id { ProgressView().controlSize(.small) }
                            else { Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(Color.textFaint) }
                        }
                        .buttonStyle(.plain)
                        .frame(width: 32, height: 32)
                        .accessibilityLabel("Remove \(c.name)")
                    }
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    Rectangle().fill(Color.line).frame(height: 1).padding(.leading, 16)
                }
                if channels.count < limit {
                    HStack(spacing: 8) {
                        TextField("", text: $link, prompt: Text("YouTube, TikTok or Instagram link").foregroundStyle(Color.textFaint))
                            .font(.tBody).foregroundStyle(Color.text)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                            .submitLabel(.done)
                            .onSubmit { Task { await add() } }
                        Button { Task { await add() } } label: {
                            if adding { ProgressView().controlSize(.small) } else { Text("Add").font(.geist(14, .medium)) }
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(link.trimmingCharacters(in: .whitespaces).isEmpty ? Color.textFaint : Color.text)
                        .disabled(adding || link.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    .padding(16)
                }
                Text(channels.count >= limit
                     ? String(localized: "All \(limit) slots are taken.")
                     : String(localized: "Up to \(limit) channels. Chumoku also finds channels in your niche on its own."))
                    .font(.tSmall).foregroundStyle(Color.textFaint)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.bottom, 14).padding(.top, channels.count >= limit ? 14 : 0)
                if let error {
                    Text(error).font(.tSmall).foregroundStyle(Color.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16).padding(.bottom, 14)
                }
            } else {
                Skeleton(cornerRadius: 10).frame(height: 44).padding(16)
            }
        }
        .task { await load() }
    }

    private func load() async {
        #if DEBUG
        if IdeasStore.isDemo { channels = []; return }
        #endif
        guard let uid = auth.user?.id else { channels = []; return }
        channels = (try? await supabase.from("competitor_channels")
            .select().eq("user_id", value: uid).order("created_at", ascending: true)
            .execute().value) ?? []
    }

    private func add() async {
        let url = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty, !adding else { return }
        adding = true
        error = nil
        defer { adding = false }
        nonisolated struct Added: Decodable { nonisolated struct Ch: Decodable { let channel_id: String? }; let channel: Ch? }
        nonisolated struct Failed: Decodable { let error: String? }
        do {
            let res: Added = try await supabase.functions.invoke("add-competitor-channel", options: FunctionInvokeOptions(body: ["channelUrl": url]))
            link = ""
            await load()
            // Its Shorts are read right away, as on the web, so the next drop has them.
            if let id = res.channel?.channel_id {
                _ = try? await supabase.functions.invoke("fetch-competitor-ideas", options: FunctionInvokeOptions(body: ["channelId": id])) as Failed
            }
        } catch let FunctionsError.httpError(_, data) {
            error = (try? JSONDecoder().decode(Failed.self, from: data))?.error ?? String(localized: "Could not add that channel.")
        } catch {
            self.error = String(localized: "Could not add that channel.")
        }
    }

    private func remove(_ c: CompetitorChannel) async {
        removing = c.id
        defer { removing = nil }
        do {
            try await supabase.from("competitor_channels").delete().eq("id", value: c.id).execute()
            channels?.removeAll { $0.id == c.id }
        } catch {
            self.error = String(localized: "Could not remove that channel.")
        }
    }
}
