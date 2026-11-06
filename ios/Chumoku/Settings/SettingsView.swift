import SwiftUI
import Supabase

// The account as the web app keeps it (user_tokens). The same settings as
// chumoku.co; plans are bought here through Apple (PlansView). Stripe
// cancelling, codes and the affiliate page stay on the web: they point at
// payment outside the app, which gets an App Store build rejected (3.1.1).
nonisolated struct Account: Decodable {
    let plan: String?
    let creditsUsed: Int?
    let bonusCredits: Int?
    let youtubeChannelName: String?
    let youtubeChannelThumbnail: String?
    let accessToken: String?
    let updatedAt: String?
    let channelDescription: String?
    let creatorLevel: String?
    let brain: Brain?
    let brainAt: String?
    let brainOverrides: BrainOverrides?
    let voice: HeardVoice?
    let retentionLessons: RetentionLessons?

    enum CodingKeys: String, CodingKey {
        case plan, brain, voice
        case creditsUsed = "credits_used"
        case bonusCredits = "bonus_credits"
        case youtubeChannelName = "youtube_channel_name"
        case youtubeChannelThumbnail = "youtube_channel_thumbnail"
        case accessToken = "access_token"
        case updatedAt = "updated_at"
        case channelDescription = "channel_description"
        case creatorLevel = "creator_level"
        case brainAt = "brain_at"
        case brainOverrides = "brain_overrides"
        case retentionLessons = "retention_lessons"
    }

    // Mirrors src/lib/useUsage.ts (free 0, Plus 100, Pro 300 since 2026-10-28).
    static let limits = ["free": 0, "pro": 100, "agency": 300]
    static var names: [String: String] { ["free": String(localized: "Trial"), "pro": "Plus", "agency": "Pro"] }

    var planName: String { Self.names[plan ?? "free"] ?? String(localized: "Trial") }
    var creditLimit: Int { (Self.limits[plan ?? "free"] ?? 20) + (bonusCredits ?? 0) }
    var creditsLeft: Int { max(0, creditLimit - (creditsUsed ?? 0)) }
    var youtubeConnected: Bool { !(accessToken ?? "").isEmpty }
}

private var creatorLevels: [(String, String, String)] { [
    ("beginner", String(localized: "Beginner"), String(localized: "New to Shorts, learning fundamentals")),
    ("intermediate", String(localized: "Intermediate"), String(localized: "Know the basics, working on execution")),
    ("advanced", String(localized: "Advanced"), String(localized: "Experienced creator, want nuance")),
] }

struct SettingsView: View {
    @Environment(AuthModel.self) private var auth
    @Environment(FilmStore.self) private var films
    @Environment(\.openURL) private var openURL
    @State private var account: Account?
    @State private var loading = true
    @State private var storage: String = "…"
    @State private var loadFailed = false
    // Channel profile
    @State private var level = "intermediate"
    @State private var about = ""
    @State private var profileSaving = false
    @State private var profileError: String?
    // The brain
    @State private var overrides = BrainOverrides()
    @State private var brainBuilding = false
    @State private var brainError: String?
    // Name and password
    @State private var name = ""
    @State private var nameSaving = false
    @State private var nameError: String?
    @State private var editingName = false
    @State private var changingPassword = false
    @State private var open: String?
    @FocusState private var focus: Bool
    @State private var manageSubscription = false
    @State private var appleSubscription: String?
    @State private var confirmClear = false
    @State private var confirmDelete = false
    @State private var deleting = false
    @State private var deleteError: String?
    @AppStorage(ContentLanguage.pickedKey) private var pickedLanguage: String?
    @AppStorage("film.countdown") private var countdown = true
    @AppStorage("film.mirror") private var mirror = true
    @AppStorage("film.4k") private var fourK = true

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Settings").font(.tTitle).foregroundStyle(Color.text).padding(.top, 8).padding(.bottom, 14)

                    planCard

                    // One section open at a time, each saying in its header
                    // what is inside, so the page fits on a screen closed.
                    fold("account", "Account", value: auth.user?.email) { accountContent }

                    fold("brain", "Chumoku brain", value: loading ? nil : (account?.brain != nil ? String(localized: "Built") : String(localized: "Not built yet")), ok: account?.brain != nil) {
                        BrainSection(
                            brain: account?.brain,
                            builtAt: account?.brainAt,
                            heardVoice: account?.voice?.howTheyTalk,
                            lessons: account?.youtubeConnected == true ? account?.retentionLessons : nil,
                            overrides: $overrides,
                            building: brainBuilding || profileSaving,
                            error: brainError ?? profileError ?? (loadFailed ? String(localized: "Could not read your profile just now, so saving is off to avoid writing over it. Pull to refresh.") : nil),
                            level: $level,
                            about: $about,
                            levels: creatorLevels,
                            canSaveProfile: !loadFailed && !loading,
                            onBuild: { Task { await buildBrain(force: false) } },
                            onSaveProfile: { await saveProfile() }
                        )
                    }

                    fold("youtube", "YouTube account", value: loading ? nil : (account?.youtubeConnected == true ? (account?.youtubeChannelName ?? String(localized: "Connected")) : String(localized: "Not connected")), ok: account?.youtubeConnected == true) {
                        YouTubeSection(
                            connected: account?.youtubeConnected ?? false,
                            channelName: account?.youtubeChannelName,
                            channelThumbnail: account?.youtubeChannelThumbnail,
                            syncedAt: account?.updatedAt,
                            loading: loading,
                            onChange: { await load() }
                        )
                    }

                    fold("social", "TikTok and Instagram") { SocialSection() }
                    fold("channels", "Competitor channels") { ChannelsSection(plan: account?.plan) }

                    fold("language", "Language", value: ContentLanguage.name(pickedLanguage ?? ContentLanguage.device)) { languageContent }

                    if Features.filming {
                        fold("filming", "Filming") {
                            toggle("Countdown before recording", $countdown)
                            divider
                            toggle("Mirror the front camera", $mirror)
                            divider
                            toggle("Record in 4K", $fourK)
                            divider
                            row("Takes on this iPhone", storage)
                            divider
                            Button { confirmClear = true } label: {
                                Text("Delete all takes").font(.tBody).foregroundStyle(Color.danger)
                                    .frame(maxWidth: .infinity, alignment: .leading).padding(16).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }

                    if auth.user?.email == Owner.email {
                        NavigationLink { AdminView() } label: {
                            HStack {
                                Text(verbatim: "Admin").font(.tBody).foregroundStyle(Color.text)
                                Spacer()
                                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.textFaint)
                            }
                            .padding(16)
                            .background(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).fill(Color.raised))
                            .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Color.line, lineWidth: 1))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }

                    // Where people talk to us: in plain sight, not folded into
                    // a Help section, and not the big banner it once was.
                    Button { if let u = URL(string: "https://discord.com/invite/N8S6C95Ry2") { openURL(u) } } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "bubble.left.and.bubble.right.fill")
                                .font(.system(size: 15)).foregroundStyle(.white)
                                .frame(width: 34, height: 34)
                                .background(Circle().fill(Color(red: 0.35, green: 0.4, blue: 0.95)))
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Join the Discord").font(.tBody).foregroundStyle(Color.text)
                                Text("Creators, feedback, early features").font(.tSmall).foregroundStyle(Color.textMuted)
                            }
                            Spacer()
                            Image(systemName: "arrow.up.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.textFaint)
                        }
                        .padding(14)
                        .background(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).fill(Color(red: 0.35, green: 0.4, blue: 0.95).opacity(0.1)))
                        .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Color(red: 0.35, green: 0.4, blue: 0.95).opacity(0.3), lineWidth: 1))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    Button("Sign out") { Task { await auth.signOut() } }
                        .buttonStyle(.pillGhost)
                        .padding(.top, 18)

                    // Required by the App Store for any app you can sign up in.
                    Button { confirmDelete = true } label: {
                        HStack(spacing: 8) {
                            if deleting { ProgressView().controlSize(.small).tint(Color.danger) }
                            Text(deleting ? "Deleting your account" : "Delete account")
                        }
                        .font(.geist(14, .medium))
                        .foregroundStyle(Color.danger)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(deleting)
                    if let deleteError {
                        Text(deleteError).font(.tSmall).foregroundStyle(Color.danger)
                            .frame(maxWidth: .infinity).multilineTextAlignment(.center)
                    }
                    HStack(spacing: 8) {
                        Button("Privacy") { if let u = URL(string: "https://chumoku.co/privacy") { openURL(u) } }
                        Text(verbatim: "·")
                        Button("Terms") { if let u = URL(string: "https://chumoku.co/terms") { openURL(u) } }
                    }
                    .font(.geist(12)).foregroundStyle(Color.textFaint).buttonStyle(.plain)
                    .frame(maxWidth: .infinity).padding(.top, 4)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 40)
            }
            // The last rows scroll clear of the floating tab bar, and what
            // passes under its glass fades instead of being cut across.
            .contentMargins(.bottom, 96, for: .scrollContent)
            .scrollEdgeEffectStyle(.soft, for: .bottom)
            .background(Color.bg.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .refreshable { await load() }
            .confirmationDialog("Delete every take on this iPhone?", isPresented: $confirmClear, titleVisibility: .visible) {
                Button("Delete all takes", role: .destructive) { films.deleteAll(); storage = films.diskUsage() }
            } message: { Text("Finished videos already in Photos stay.") }
            .sensoryFeedback(.warning, trigger: confirmClear) { _, on in on }
            .confirmationDialog("Delete your Chumoku account?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete account", role: .destructive) { Task { await deleteAccount() } }
            } message: {
                Text("Your ideas, chats, channels, credits and brain are deleted for good, here and on chumoku.co. A paid plan is cancelled now. This can't be undone.")
            }
            .sensoryFeedback(.warning, trigger: confirmDelete) { _, on in on }
            .scrollDismissesKeyboard(.interactively)
            .sheet(isPresented: $changingPassword) { PasswordSheet(email: auth.user?.email) }
            .manageSubscriptionsSheet(isPresented: $manageSubscription)
            .onChange(of: Purchases.shared.changed) { Task { await load() } }
            .onChange(of: manageSubscription) { _, open in if !open { Task { await load() } } }
        }
        .task { await load() }
    }

    // The plan, the balance and the way to more, always on top: the one
    // thing on this page that is about money is never folded away.
    private var planCard: some View {
        let free = (account?.plan ?? "free") == "free"
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: account?.planName ?? (loading ? " " : String(localized: "Trial")))
                    .font(.tHeading).foregroundStyle(Color.text)
                Spacer()
                Text(account.map { $0.creditLimit == 0 ? String(localized: "Daily ideas only") : String(localized: "\($0.creditsLeft) of \($0.creditLimit) left") } ?? " ")
                    .font(.tSmall).foregroundStyle(Color.textMuted).monospacedDigit()
            }
            if let a = account, a.creditLimit > 0 {
                GeometryReader { g in
                    Capsule().fill(Color.white.opacity(0.08))
                        .overlay(alignment: .leading) {
                            Capsule().fill(Color.white)
                                .frame(width: g.size.width * CGFloat(a.creditsLeft) / CGFloat(max(1, a.creditLimit)))
                        }
                }
                .frame(height: 4)
            }
            if free {
                Button("Upgrade") { Purchases.shared.showPlans = true }.buttonStyle(.pill)
            } else {
                HStack(spacing: 8) {
                    Button("Get more credits") { Purchases.shared.showPlans = true }.buttonStyle(.pillSecondary)
                    if appleSubscription != nil {
                        Button("Manage") { manageSubscription = true }.buttonStyle(.pillSecondary)
                    }
                }
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).fill(Color.raised))
        .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Color.line, lineWidth: 1))
    }

    // Editable things say Edit; the email, which cannot change here, says
    // so with a lock instead of looking like a field.
    @ViewBuilder private var accountContent: some View {
        if editingName {
            VStack(alignment: .leading, spacing: 10) {
                Text("Name").font(.tLabel).foregroundStyle(Color.textMuted)
                TextField("What we should call you", text: $name)
                    .textInputAutocapitalization(.words)
                    .submitLabel(.done)
                    .focused($focus)
                    .onSubmit { Task { await saveName() } }
                    .field()
                if let nameError { Text(nameError).font(.tSmall).foregroundStyle(Color.danger) }
                HStack(spacing: 8) {
                    Button("Cancel") { name = currentName; nameError = nil; editingName = false; focus = false }
                        .buttonStyle(.pillSecondary)
                    Button { Task { await saveName() } } label: { Text(nameSaving ? "Saving" : "Save") }
                        .buttonStyle(.pill)
                        .disabled(nameSaving || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .padding(16)
        } else {
            HStack(spacing: 10) {
                Text("Name").font(.tBody).foregroundStyle(Color.text)
                Spacer()
                Text(verbatim: currentName).font(.tBody).foregroundStyle(Color.textMuted).lineLimit(1)
                Button("Edit") { name = currentName; editingName = true; focus = true }
                    .font(.geist(14, .medium)).foregroundStyle(Color.text).buttonStyle(.plain)
            }
            .padding(16)
        }
        divider
        HStack(spacing: 10) {
            Text("Email").font(.tBody).foregroundStyle(Color.text)
            Spacer()
            Text(verbatim: auth.user?.email ?? "").font(.tBody).foregroundStyle(Color.textFaint).lineLimit(1)
            Image(systemName: "lock.fill").font(.system(size: 11)).foregroundStyle(Color.textFaint)
                .accessibilityLabel(Text("Can't be changed"))
        }
        .padding(16)
        if hasPassword {
            divider
            Button { changingPassword = true } label: {
                HStack {
                    Text("Change password").font(.tBody).foregroundStyle(Color.text)
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.textFaint)
                }
                .padding(16).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder private var languageContent: some View {
        Menu {
            Button { pick(nil) } label: {
                if pickedLanguage == nil { Label("Same as iPhone", systemImage: "checkmark") } else { Text("Same as iPhone") }
            }
            ForEach(ContentLanguage.all, id: \.code) { l in
                Button { pick(l.code) } label: {
                    if pickedLanguage == l.code { Label(l.name, systemImage: "checkmark") } else { Text(verbatim: l.name) }
                }
            }
        } label: {
            HStack {
                Text("Ideas and scripts").font(.tBody).foregroundStyle(Color.text)
                Spacer()
                Text(verbatim: ContentLanguage.name(pickedLanguage ?? ContentLanguage.device)).font(.tBody).foregroundStyle(Color.textMuted)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(Color.textFaint)
            }
            .padding(16).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        divider
        // iOS keeps a per-app language for any app that ships more than one;
        // this opens Chumoku's page in Settings.
        linkRow("App language", url: UIApplication.openSettingsURLString)
    }

    private func fold<Content: View>(_ id: String, _ title: LocalizedStringKey, value: String? = nil, ok: Bool = false, @ViewBuilder _ content: () -> Content) -> some View {
        let isOpen = open == id
        return VStack(spacing: 0) {
            Button { withAnimation(.ui) { open = isOpen ? nil : id } } label: {
                HStack(spacing: 10) {
                    Text(title).font(.tBody).foregroundStyle(Color.text)
                    Spacer(minLength: 12)
                    if let value, !isOpen {
                        Text(verbatim: value).font(.tSmall).foregroundStyle(Color.textFaint).lineLimit(1)
                    }
                    // Connected, built: a green check, the app's "done". In a
                    // fixed slot by the chevron, so every row's check lines up
                    // whatever the text before it.
                    if ok && !isOpen {
                        Image(systemName: "checkmark.circle.fill").font(.system(size: 14)).foregroundStyle(Color.process)
                    }
                    Image(systemName: "chevron.down")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.textFaint)
                        .rotationEffect(.degrees(isOpen ? 180 : 0))
                }
                .padding(16)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if isOpen {
                Rectangle().fill(Color.line).frame(height: 1)
                content()
            }
        }
        .background(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).fill(Color.raised))
        .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Color.line, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
        .sensoryFeedback(.selection, trigger: isOpen)
    }

    private func deleteAccount() async {
        nonisolated struct Failed: Decodable { let error: String? }
        deleting = true
        deleteError = nil
        defer { deleting = false }
        do {
            var body = ["confirm": "DELETE"]
            if auth.user?.identities?.contains(where: { $0.provider == "apple" }) == true,
               let code = await AppleAuthorizationCode.request() {
                body["appleAuthorizationCode"] = code
            }
            try await supabase.functions.invoke("delete-account", options: FunctionInvokeOptions(body: body))
            // The user is gone server-side; only the session on this phone is left.
            try? await supabase.auth.signOut(scope: .local)
        } catch let FunctionsError.httpError(_, data) {
            deleteError = (try? JSONDecoder().decode(Failed.self, from: data))?.error ?? String(localized: "Could not delete the account. Try again.")
        } catch {
            deleteError = String(localized: "Could not delete the account. Try again.")
        }
    }

    private func load() async {
        storage = films.diskUsage()
        if name.isEmpty { name = currentName }
        appleSubscription = await Purchases.shared.activeSubscription()
        await Purchases.shared.refreshPlan()
        defer { loading = false }
        guard let uid = auth.user?.id else { return }
        do {
            let rows: [Account] = try await supabase.from("user_tokens")
                .select("plan, credits_used, bonus_credits, youtube_channel_name, youtube_channel_thumbnail, access_token, updated_at, channel_description, creator_level, brain, brain_at, brain_overrides, voice, retention_lessons")
                .eq("user_id", value: uid)
                .limit(1)
                .execute()
                .value
            account = rows.first
            loadFailed = false
            about = account?.channelDescription ?? ""
            level = account?.creatorLevel ?? "intermediate"
            overrides = account?.brainOverrides ?? BrainOverrides()
        } catch {
            // Empty fields saved over a perfectly good profile would be worse
            // than not saving at all.
            loadFailed = true
        }
    }

    private func pick(_ code: String?) {
        pickedLanguage = code
        Task { await ContentLanguage.save(code ?? ContentLanguage.device) }
    }

    // MARK: name, profile, brain

    private var currentName: String {
        let meta = auth.user?.userMetadata ?? [:]
        for key in ["display_name", "full_name", "name"] {
            if case .string(let v) = meta[key], !v.trimmingCharacters(in: .whitespaces).isEmpty { return v.trimmingCharacters(in: .whitespaces) }
        }
        return auth.user?.email?.split(separator: "@").first.map(String.init) ?? ""
    }

    // Apple and Google accounts have no password to change.
    private var hasPassword: Bool {
        auth.user?.identities?.contains { $0.provider == "email" } ?? false
    }

    private func saveName() async {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty, n != currentName else { editingName = false; return }
        focus = false
        nameSaving = true
        nameError = nil
        defer { nameSaving = false }
        do {
            try await supabase.auth.update(user: UserAttributes(data: ["display_name": .string(String(n.prefix(40)))]))
            editingName = false
        } catch {
            nameError = error.localizedDescription
        }
    }

    // One button, two things, as on the web: the two fields go to the row,
    // and the brain is rebuilt off them.
    private func saveProfile() async {
        guard let uid = auth.user?.id else { return }
        nonisolated struct Patch: Encodable { let channel_description: String; let creator_level: String }
        nonisolated struct NewRow: Encodable {
            let user_id: String; let channel_description: String; let creator_level: String
            let access_token = ""; let refresh_token = ""
        }
        focus = false
        profileSaving = true
        profileError = nil
        defer { profileSaving = false }
        do {
            if account != nil {
                try await supabase.from("user_tokens").update(Patch(channel_description: about, creator_level: level))
                    .eq("user_id", value: uid).execute()
            } else {
                try await supabase.from("user_tokens")
                    .insert(NewRow(user_id: uid.uuidString.lowercased(), channel_description: about, creator_level: level)).execute()
            }
        } catch {
            profileError = String(localized: "Failed to save: \(error.localizedDescription)")
            return
        }
        profileSaving = false
        await buildBrain(force: true)
    }

    // `force` skips build-brain's one-minute cooldown; only a profile save
    // passes it, so Rebuild pressed twice reads the channel once.
    private func buildBrain(force: Bool) async {
        nonisolated struct Result: Decodable { let brain: Brain?; let cached: Bool?; let reason: String?; let error: String? }
        nonisolated struct Failed: Decodable { let error: String? }
        brainBuilding = true
        brainError = nil
        defer { brainBuilding = false }
        do {
            let r: Result = try await supabase.functions.invoke("build-brain", options: FunctionInvokeOptions(body: ["force": force]))
            if r.cached == true {
                brainError = String(localized: "Rebuilt less than a minute ago. Give it a moment.")
            } else if r.brain != nil {
                await load()
            } else if r.reason == "nothing_to_read" {
                brainError = String(localized: "Nothing to read yet. Say a line about yourself above, or connect your channel.")
            }
        } catch let FunctionsError.httpError(_, data) {
            brainError = (try? JSONDecoder().decode(Failed.self, from: data))?.error ?? String(localized: "Could not read your channel")
        } catch {
            brainError = String(localized: "Could not read your channel")
        }
    }

    // MARK: pieces

    private var divider: some View { Rectangle().fill(Color.line).frame(height: 1).padding(.leading, 16) }

    private func row(_ label: LocalizedStringKey, _ value: String) -> some View {
        HStack {
            Text(label).font(.tBody).foregroundStyle(Color.text)
            Spacer()
            Text(value).font(.tBody).foregroundStyle(Color.textMuted).lineLimit(1)
        }
        .padding(16)
    }

    private func toggle(_ label: LocalizedStringKey, _ value: Binding<Bool>) -> some View {
        Toggle(isOn: value) { Text(label).font(.tBody).foregroundStyle(Color.text) }
            .tint(Color.process)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .sensoryFeedback(.selection, trigger: value.wrappedValue)
    }

    private func linkRow(_ label: LocalizedStringKey, url: String) -> some View {
        Button { if let u = URL(string: url) { openURL(u) } } label: {
            HStack {
                Text(label).font(.tBody).foregroundStyle(Color.text)
                Spacer()
                Image(systemName: "arrow.up.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.textFaint)
            }
            .padding(16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// The current password is checked by signing in with it first, as on the web.
private struct PasswordSheet: View {
    let email: String?
    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var next = ""
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                SecureField("Current password", text: $current).textContentType(.password).field()
                SecureField("New password", text: $next).textContentType(.newPassword).field()
                if let error {
                    Text(error).font(.tSmall).foregroundStyle(Color.danger).frame(maxWidth: .infinity, alignment: .leading)
                }
                Button { Task { await save() } } label: { Text(saving ? "Updating" : "Update password") }
                    .buttonStyle(.pill)
                    .disabled(saving || current.isEmpty || next.isEmpty)
                    .padding(.top, 8)
                Spacer()
            }
            .padding(20)
            .background(Color.bg.ignoresSafeArea())
            .navigationTitle("Change password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium])
        .preferredColorScheme(.dark)
    }

    private func save() async {
        guard next.count >= 6 else { error = String(localized: "New password must be at least 6 characters"); return }
        guard let email else { error = String(localized: "Could not confirm your account"); return }
        saving = true
        error = nil
        defer { saving = false }
        do {
            try await supabase.auth.signIn(email: email, password: current)
        } catch {
            self.error = String(localized: "Current password is incorrect")
            return
        }
        do {
            try await supabase.auth.update(user: UserAttributes(password: next))
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
