import SwiftUI
import Supabase

@main
struct ChumokuApp: App {
    @State private var auth = AuthModel()
    @State private var ideas = IdeasStore()
    @State private var films = FilmStore()
    @State private var notes = NotesStore.shared
    @State private var chat = ChatStore.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(auth)
                .environment(ideas)
                .environment(films)
                .environment(notes)
                .environment(chat)
                .preferredColorScheme(.dark)
                .tint(.white)
                // Listening from launch: renewals and purchases left
                // unfinished last time arrive whenever StoreKit has them.
                .task { Purchases.shared.start() }
        }
    }
}

struct RootView: View {
    @Environment(AuthModel.self) private var auth

    var body: some View {
        Group {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("-onboarding") { OnboardingView {} }
            else if IdeasStore.isDemo { MainTabs() } else { content }
            #else
            content
            #endif
        }
        .animation(.easeOut(duration: 0.2), value: auth.user?.id)
    }

    @ViewBuilder private var content: some View {
        Group {
            switch auth.state {
            case .loading: Color.bg.ignoresSafeArea()
            case .signedOut: SignInView()
            case .signedIn(let user): SignedInRoot().id(user.id)
            }
        }
    }
}

// Onboarding once, for an account that has neither finished it (here or on
// the web) nor a brain to show for it; everyone else goes straight in.
struct SignedInRoot: View {
    @Environment(AuthModel.self) private var auth
    @State private var needsOnboarding: Bool?

    var body: some View {
        Group {
            switch needsOnboarding {
            case nil: Color.bg.ignoresSafeArea()
            case true?: OnboardingView { withAnimation(.ui) { needsOnboarding = false } }
            case false?: MainTabs()
            }
        }
        .task {
            nonisolated struct Row: Decodable { let onboarding_completed: Bool?; let brain: Brain? }
            guard let uid = auth.user?.id else { needsOnboarding = false; return }
            do {
                let rows: [Row] = try await supabase.from("user_tokens").select("onboarding_completed, brain")
                    .eq("user_id", value: uid).limit(1).execute().value
                let row = rows.first
                needsOnboarding = row?.onboarding_completed != true && row?.brain == nil
            } catch {
                // A failed read must not trap an existing account in onboarding.
                needsOnboarding = false
            }
        }
    }
}

struct MainTabs: View {
    @Environment(NotesStore.self) private var notes
    @Environment(ChatStore.self) private var chat
    enum T: Hashable { case ideas, chat, saved, create, edit, analytics, settings, plans }
    @State private var tab: T = .ideas
    // Subscribers only since 2026-11-09. Settings stays open for signing out and deleting the account.
    private var locked: Bool { Purchases.shared.plan == "free" }

    var body: some View {
        TabView(selection: $tab) {
            if locked {
                Tab("Plans", image: "TabPlans", value: T.plans) { PlansView(embedded: true) }
            } else {
                Tab("Ideas", image: "TabIdeas", value: T.ideas) { IdeasView() }
                Tab("Chat", image: "TabChat", value: T.chat) { ChatView() }
                Tab("Saved", image: "TabSaved", value: T.saved) { SavedView() }
            }
            if Features.filming && !locked {
                Tab("Edit", systemImage: "scissors", value: T.edit) { EditHome() }
                Tab("Create", systemImage: "plus", value: T.create) { FilmHome() }
                Tab("Analytics", systemImage: "chart.bar", value: T.analytics) { AnalyticsView() }
            }
            Tab("Settings", image: "TabSettings", value: T.settings) { SettingsView() }
        }
        .sensoryFeedback(.selection, trigger: tab)
        .onChange(of: locked, initial: true) { _, now in
            if now { if tab != .settings { tab = .plans } } else if tab == .plans { tab = .ideas }
        }
        // "Record an idea" from Siri or the Lock Screen lands in Notes.
        .onChange(of: notes.recordNow) { _, now in if now { tab = .ideas } }
        // An idea sent to Chat ("Work on it in Chat") brings Chat forward.
        .onChange(of: chat.pending?.ideaId) { _, id in if id != nil { tab = .chat } }
        // Anything that runs out of credits opens the plans.
        .sheet(isPresented: Bindable(Purchases.shared).showPlans) { PlansView() }
        .task { await ContentLanguage.sync() }
        .task { await Purchases.shared.refreshPlan() }
    }
}
