import Foundation
import Supabase

nonisolated struct OutlineSection: Codable, Hashable {
    let title: String
    let content: String
    let duration: String?
}

nonisolated struct Outline: Codable, Hashable {
    let hook: String
    let sections: [OutlineSection]
    let cta: String

    // What you read while filming: hook, every section, the call to action.
    var script: String {
        ([hook] + sections.map(\.content) + [cta]).filter { !$0.isEmpty }.joined(separator: "\n\n")
    }
}

// Where an idea Chumoku found itself came from (competitor_ideas.basis):
// something new in the creator's subject ("research"), or one of their own
// Shorts that beat their usual ("remix"). The first rows (2026-10-27) have no
// kind and are remixes.
nonisolated struct IdeaBasis: Codable, Hashable {
    let kind: String?
    let hook: String?
    let source: String?
    let why: String?
    let videoId: String?
    let title: String?
    let views: Int?
    let multiple: Double?

    enum CodingKeys: String, CodingKey {
        case kind, hook, source, why, title, views, multiple
        case videoId = "video_id"
    }

    var isRemix: Bool { kind != "research" && title != nil }
}

// A row of competitor_ideas, the same table the web Ideas tab reads.
nonisolated struct Idea: Codable, Identifiable, Hashable {
    let id: String
    let channelName: String?
    let videoId: String
    let videoTitle: String?
    let videoThumbnail: String?
    let videoViews: Int?
    let outlierScore: Double?
    let pitch: String?
    let fit: String?
    let concept: String?
    let adaptedIdea: String?
    let outline: Outline?
    let script: String?
    var liked: Bool?
    let createdAt: String?
    // 'ai' when Chumoku found the idea rather than took it from a Short: no
    // real video behind it, `videoId` is a made-up `ai-` key.
    var source: String? = nil
    var basis: IdeaBasis? = nil

    enum CodingKeys: String, CodingKey {
        case id, pitch, fit, concept, outline, liked, script, source, basis
        case channelName = "channel_name"
        case videoId = "video_id"
        case videoTitle = "video_title"
        case videoThumbnail = "video_thumbnail"
        case videoViews = "video_views"
        case outlierScore = "outlier_score"
        case adaptedIdea = "adapted_idea"
        case createdAt = "created_at"
    }

    // The line worth reading first: the hook if one was written, then the
    // pitch for this creator, then the source title.
    var headline: String { outline?.hook ?? pitch ?? videoTitle ?? String(localized: "Untitled") }

    var isOwn: Bool { source == "ai" }

    // TikTok and Instagram ids carry their platform; their covers are in our
    // own storage because the platforms' links expire.
    private var isSocial: Bool { videoId.hasPrefix("tiktok:") || videoId.hasPrefix("instagram:") }

    var thumbnailURL: URL? {
        if isOwn { return nil }
        if let videoThumbnail { return URL(string: videoThumbnail) }
        if isSocial {
            let name = videoId.replacingOccurrences(of: ":", with: "-")
            return URL(string: "https://ezlousklksipvwuinpzq.supabase.co/storage/v1/object/public/social-thumbs/\(name).jpg")
        }
        return URL(string: "https://i.ytimg.com/vi/\(videoId)/sddefault.jpg")
    }

    var shortsURL: URL? {
        if isOwn { return nil }
        let native = videoId.split(separator: ":").last.map(String.init) ?? videoId
        if videoId.hasPrefix("tiktok:") { return URL(string: "https://www.tiktok.com/@_/video/\(native)") }
        if videoId.hasPrefix("instagram:") { return URL(string: "https://www.instagram.com/reel/\(native)/") }
        return URL(string: "https://www.youtube.com/shorts/\(videoId)")
    }

    // "14×": how far it beat its own channel, the number the feed is sorted by.
    // The web shows one decimal under 10 ("3.9×").
    var outlierBadge: String? {
        guard !isOwn, let o = outlierScore, o >= 1.5, o < 1000 else { return nil }
        return o < 10 ? "\(String(format: "%.1f", o).replacingOccurrences(of: ".0", with: ""))×" : "\(Int(o.rounded()))×"
    }

    // Under the title of an idea Chumoku found: what kind, and that nothing has
    // proved it yet.
    var ownLabel: String { "\(basis?.isRemix == true ? String(localized: "Remix of your Short") : String(localized: "Researched for you")) · \(String(localized: "untested"))" }

    // The cover of an idea Chumoku found: the line they would open on.
    var openingLine: String {
        if let h = basis?.hook?.trimmingCharacters(in: .whitespacesAndNewlines), !h.isEmpty {
            return "“" + h.trimmingCharacters(in: CharacterSet(charactersIn: "\"“”")) + "”"
        }
        return adaptedIdea ?? pitch ?? ""
    }

    // What the cover says it came from.
    var basisLine: String? {
        guard let b = basis else { return nil }
        if b.isRemix {
            if let m = b.multiple, m >= 1.2 { let x = String(format: "%.1f", m).replacingOccurrences(of: ".0", with: ""); return String(localized: "Remix of your Short · \(x)× your usual") }
            return String(localized: "Remix of your Short")
        }
        return b.source
    }

    // What you read off the prompter: the written script, else the outline,
    // else the angle.
    var filmScript: String { script ?? outline?.script ?? adaptedIdea ?? "" }

    // The web card's line: fit, channel, views.
    var cardMeta: String {
        if isOwn { return ownLabel }
        return [channelName, videoViews.map(Idea.compact)].compactMap { $0 }.joined(separator: " · ")
    }

    var meta: String {
        var parts: [String] = []
        if let v = videoViews { parts.append(String(localized: "\(Idea.compact(v)) views")) }
        if let o = outlierScore, o >= 1, o < 1000 { parts.append(String(localized: "\(Int(o.rounded()))× its channel")) }
        return parts.joined(separator: " · ")
    }

    static func compact(_ n: Int) -> String {
        func trim(_ d: Double) -> String { String(format: "%.1f", d).replacingOccurrences(of: ".0", with: "") }
        if n >= 1_000_000 { return trim(Double(n) / 1_000_000) + "M" }
        if n >= 1_000 { return trim(Double(n) / 1_000) + "K" }
        return String(n)
    }
}

nonisolated struct DailyDrop: Decodable {
    nonisolated struct More: Decodable { let added: Int; let error: String? }
    let date: String
    let nextAt: String
    let size: Int
    let items: [Idea]
    let needsProfile: Bool?
    let more: More?
}

@Observable
final class IdeasStore {
    var today: [Idea] = []
    var saved: [Idea] = []
    var dismissed: [Idea] = []
    var findingMore = false
    var moreNote: String?
    var nextAt: Date?
    var needsProfile = false
    var loadingToday = false
    var loadingSaved = false
    var error: String?
    // Which ideas have a model call running, and which step.
    enum Step { case script }
    var working: [String: Step] = [:]

    // Today's drop, built server-side on the first call of the day, so the
    // first open can take a few seconds.
    func loadToday() async {
        #if DEBUG
        if Self.isDemo { if today.isEmpty { fillDemo() }; return }
        #endif
        loadingToday = true
        defer { loadingToday = false }
        do {
            apply(try await fetchDrop(more: false))
            error = nil
        } catch {
            self.error = String(localized: "Could not load today's ideas.")
        }
    }

    // Five more ideas Chumoku researches on the spot, for credits (the web's
    // "5 more ideas"). Charged only when some arrive.
    func more() async {
        #if DEBUG
        if Self.isDemo { moreNote = String(localized: "Not in demo mode."); return }
        #endif
        findingMore = true
        moreNote = nil
        defer { findingMore = false }
        do {
            let drop = try await fetchDrop(more: true)
            apply(drop)
            if drop.more?.error == "limit_reached" {
                moreNote = String(localized: "That takes \(Self.moreCost) credits and you're out for this month.")
                Purchases.shared.showPlans = true
            }
            else if (drop.more?.added ?? 0) == 0 { moreNote = String(localized: "Could not research anything new just now. Try again in a minute.") }
        } catch {
            moreNote = String(localized: "Could not research just now. Try again in a minute.")
        }
    }

    static let moreCost = 3 // CREDIT_COSTS.more_ideas

    private func fetchDrop(more: Bool) async throws -> DailyDrop {
        var body: [String: AnyJSON] = ["timezone": .string(TimeZone.current.identifier)]
        if more { body["more"] = .bool(true) }
        return try await supabase.functions.invoke("daily-ideas", options: FunctionInvokeOptions(body: body))
    }

    private func apply(_ drop: DailyDrop) {
        today = drop.items
        needsProfile = drop.needsProfile ?? false
        nextAt = ISO8601DateFormatter.withFractions.date(from: drop.nextAt) ?? ISO8601DateFormatter().date(from: drop.nextAt)
        let next = nextAt
        Task { await Reminders.schedule(at: next) }
    }

    func loadSaved() async {
        if let list = await load(liked: true) { saved = list }
    }

    func loadDismissed() async {
        if let list = await load(liked: false) { dismissed = list }
    }

    private func load(liked: Bool) async -> [Idea]? {
        #if DEBUG
        if Self.isDemo { return nil }
        #endif
        guard let uid = try? await supabase.auth.session.user.id else { return nil }
        loadingSaved = true
        defer { loadingSaved = false }
        do {
            return try await supabase.from("competitor_ideas")
                .select()
                .eq("user_id", value: uid)
                .eq("liked", value: liked)
                .order("created_at", ascending: false)
                .limit(100)
                .execute()
                .value
        } catch {
            self.error = liked ? String(localized: "Could not load saved ideas.") : String(localized: "Could not load dismissed ideas.")
            return nil
        }
    }

    // Save (true), dismiss (false) or undo (nil), written straight through.
    func rule(_ idea: Idea, liked: Bool?) async {
        func apply(_ list: inout [Idea]) {
            if let i = list.firstIndex(where: { $0.id == idea.id }) { list[i].liked = liked }
        }
        apply(&today)
        apply(&saved)
        apply(&dismissed)
        var moved = idea
        moved.liked = liked
        if liked == true, !saved.contains(where: { $0.id == idea.id }) { saved.insert(moved, at: 0) }
        if liked == true {
            let next = nextAt
            Task { await Reminders.askOnce(); await Reminders.schedule(at: next) }
        }
        if liked == false, !dismissed.contains(where: { $0.id == idea.id }) { dismissed.insert(moved, at: 0) }
        if liked != true { saved.removeAll { $0.id == idea.id } }
        if liked != false { dismissed.removeAll { $0.id == idea.id } }
        #if DEBUG
        if Self.isDemo { return }
        #endif
        do {
            try await supabase.from("competitor_ideas")
                .update(["liked": liked])
                .eq("id", value: idea.id)
                .execute()
        } catch {
            self.error = String(localized: "Could not save that. Try again.")
        }
    }
}

extension IdeasStore {
    nonisolated private struct IdeaResponse: Decodable { let idea: Idea }
    nonisolated private struct ErrorBody: Decodable { let error: String? }

    static let scriptCost = 3 // CREDIT_COSTS.script

    // The whole way from the idea to the words to say, in one call: reads and
    // watches the source Short when there is one, then writes. 3 credits.
    func writeScript(_ idea: Idea) async -> String? {
        await run(idea, .script, "write-script", ["ideaId": .string(idea.id)])
    }

    // Returns an error to show, or nil when the idea was updated.
    private func run(_ idea: Idea, _ step: Step, _ fn: String, _ body: [String: AnyJSON]) async -> String? {
        #if DEBUG
        if Self.isDemo { return String(localized: "Not in demo mode.") }
        #endif
        working[idea.id] = step
        defer { working[idea.id] = nil }
        do {
            let res: IdeaResponse = try await supabase.functions.invoke(fn, options: FunctionInvokeOptions(body: body))
            replace(res.idea)
            return nil
        } catch let FunctionsError.httpError(_, data) {
            let msg = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
            if msg == "limit_reached" || msg == "upgrade_required" {
                Purchases.shared.showPlans = true
                return msg == "limit_reached" ? String(localized: "You're out of credits for this month.") : String(localized: "This isn't included in your plan.")
            }
            return msg ?? String(localized: "Something went wrong. Try again.")
        } catch {
            return String(localized: "Something went wrong. Try again.")
        }
    }

    private func replace(_ updated: Idea) {
        if let i = today.firstIndex(where: { $0.id == updated.id || $0.videoId == updated.videoId }) { today[i] = updated }
        if let i = saved.firstIndex(where: { $0.id == updated.id }) { saved[i] = updated }
        if let i = dismissed.firstIndex(where: { $0.id == updated.id }) { dismissed[i] = updated }
    }

    func live(_ idea: Idea) -> Idea {
        today.first { $0.id == idea.id } ?? saved.first { $0.id == idea.id } ?? dismissed.first { $0.id == idea.id } ?? idea
    }
}

extension ISO8601DateFormatter {
    nonisolated(unsafe) static let withFractions: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
