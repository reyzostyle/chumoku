import SwiftUI

// The Ideas tab, the web's Ideas page on a phone (rebuilt 2026-10-28):
// Today / Saved / Dismissed, today's drop as a grid or a swipe stack, and
// five more researched ideas for credits any time. Voice notes sit in a
// fourth segment only while filming is switched on (Features.filming).
struct IdeasView: View {
    @Environment(IdeasStore.self) private var store
    @Environment(NotesStore.self) private var notes
    enum Tab: Hashable { case today, saved, dismissed, notes }
    @State private var tab: Tab = .today
    @State private var path = NavigationPath()
    // Swipe by default (Ivan, 2026-10-30); the grid is one tap away.
    @AppStorage("ideas.swipe2") private var swipe = true

    private let columns = [GridItem(.flexible(), spacing: 12, alignment: .top), GridItem(.flexible(), spacing: 12, alignment: .top)]

    private var tabs: [(Tab, String)] {
        let undecided = store.today.filter { $0.liked == nil }.count
        var t: [(Tab, String)] = [
            (.today, store.today.isEmpty ? String(localized: "Today") : String(localized: "Today (\(undecided))")),
            (.saved, String(localized: "Saved")),
            (.dismissed, String(localized: "Dismissed")),
        ]
        if Features.filming { t.append((.notes, String(localized: "Notes"))) }
        return t
    }

    private var swiping: Bool { tab == .today && swipe && store.today.contains { $0.liked == nil } }

    var body: some View {
        NavigationStack(path: $path) {
            VStack(alignment: .leading, spacing: 0) {
                header
                    .padding(.horizontal, 20)
                if swiping {
                    // The stack gets the rest of the screen and sizes itself to
                    // it, so the buttons are never below the fold.
                    // Clear of the floating tab bar: the round buttons sat
                    // right under its glass, which bent them (Ivan, 2026-10-30).
                    SwipeStack { path.append($0) }
                        .padding(.horizontal, 20)
                        .padding(.top, 14)
                        .padding(.bottom, 34)
                } else {
                    ScrollView {
                        Group {
                            if tab == .notes { NotesView() } else { content }
                        }
                        .padding(.horizontal, 20)
                        .padding(.top, 16)
                        .padding(.bottom, 32)
                    }
                    .refreshable { await reload() }
                }
            }
            .scrollEdgeEffectStyle(.soft, for: .bottom)
            .background(Color.bg.ignoresSafeArea())
            .navigationDestination(for: Idea.self) { idea in
                IdeaDetailView(idea: idea)
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        .task { await store.loadToday() }
        .onChange(of: notes.recordNow) { _, now in if now && Features.filming { path = NavigationPath(); tab = .notes } }
        .onAppear { if notes.recordNow && Features.filming { tab = .notes } }
        .task(id: tab) {
            if tab == .saved { await store.loadSaved() }
            if tab == .dismissed { await store.loadDismissed() }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center) {
                Text("Ideas").font(.tTitle).foregroundStyle(Color.text)
                Spacer()
            }
            .padding(.top, 8)
            HStack(spacing: 8) {
                ScrollView(.horizontal, showsIndicators: false) {
                    Seg(options: tabs, value: $tab)
                }
                .scrollBounceBehavior(.basedOnSize)
                if tab == .today && !store.today.isEmpty {
                    IconSeg(options: [(false, "square.grid.2x2", String(localized: "Grid")), (true, "rectangle.stack", String(localized: "Swipe"))], value: $swipe)
                        .fixedSize()
                }
            }
            if tab == .today && !store.today.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    if let note = store.moreNote {
                        Text(note).font(.tSmall).foregroundStyle(Color.textMuted).lineLimit(2)
                    } else if let next = store.nextAt {
                        Countdown(until: next)
                    }
                    Spacer(minLength: 0)
                    MoreButton()
                }
            }
        }
    }

    @ViewBuilder private var content: some View {
        let list = tab == .today ? store.today : tab == .saved ? store.saved : store.dismissed
        let loading = tab == .today ? store.loadingToday : store.loadingSaved
        if loading && list.isEmpty {
            LazyVGrid(columns: columns, spacing: 16) {
                ForEach(0..<4, id: \.self) { _ in Skeleton().aspectRatio(0.62, contentMode: .fit) }
            }
        } else if list.isEmpty {
            VStack(spacing: 14) {
                Empty(text: emptyText)
                if tab == .today && !store.needsProfile { MoreButton(prominent: true) }
            }
        } else {
            LazyVGrid(columns: columns, spacing: 18) {
                ForEach(list) { idea in
                    NavigationLink(value: idea) { IdeaCard(idea: idea).contentShape(Rectangle()) }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button(idea.liked == true ? "Unsave" : "Save", systemImage: idea.liked == true ? "heart.slash" : "heart") {
                                Task { await store.rule(idea, liked: idea.liked == true ? nil : true) }
                            }
                            Button(idea.liked == false ? "Restore" : "Dismiss", systemImage: idea.liked == false ? "arrow.uturn.backward" : "xmark") {
                                Task { await store.rule(idea, liked: idea.liked == false ? nil : false) }
                            }
                        }
                }
            }
        }
        if let error = store.error {
            Text(error).font(.tSmall).foregroundStyle(Color.danger).padding(.top, 16)
        }
    }

    private var emptyText: String {
        switch tab {
        case .saved: return String(localized: "Nothing saved yet. Save an idea and it lands here.")
        case .dismissed: return String(localized: "Nothing dismissed.")
        default:
            if store.needsProfile { return String(localized: "Connect your YouTube channel in Settings so Chumoku knows what to look for.") }
            if let note = store.moreNote { return note }
            return String(localized: "Nothing new right now. Pull to check again.")
        }
    }

    private func reload() async {
        switch tab {
        case .today: await store.loadToday()
        case .saved: await store.loadSaved()
        case .dismissed: await store.loadDismissed()
        case .notes: break
        }
    }
}

// "5 more ideas · 3 credits": researched on the spot.
struct MoreButton: View {
    @Environment(IdeasStore.self) private var store
    var prominent = false

    var body: some View {
        Button { Task { await store.more() } } label: {
            HStack(spacing: 6) {
                if store.findingMore { ProgressView().controlSize(.mini).tint(Color.textMuted) }
                Text(store.findingMore ? "Researching" : "5 more ideas · \(IdeasStore.moreCost) credits")
            }
        }
        .disabled(store.findingMore)
        .modifier(MoreStyle(prominent: prominent))
    }
}

private struct MoreStyle: ViewModifier {
    let prominent: Bool
    func body(content: Content) -> some View {
        if prominent {
            content.buttonStyle(.pill).frame(maxWidth: 260)
        } else {
            content.buttonStyle(.plain).font(.geist(13, .medium)).foregroundStyle(Color.textMuted).fixedSize()
        }
    }
}

struct IdeaCard: View {
    let idea: Idea

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            IdeaCover(idea: idea)
                .aspectRatio(4 / 5, contentMode: .fit)
                .overlay(alignment: .topTrailing) {
                    if idea.liked == true {
                        Image(systemName: "heart.fill")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Color.text)
                            .padding(7)
                            .background(Circle().fill(.black.opacity(0.55)))
                            .padding(8)
                    }
                }
                .opacity(idea.liked == false ? 0.45 : 1)
            Text(idea.isOwn ? (idea.pitch ?? idea.headline) : idea.headline)
                .font(.geist(14, .medium))
                .foregroundStyle(Color.text)
                .lineLimit(3)
                .multilineTextAlignment(.leading)
            MetaLine(idea: idea)
        }
    }
}

// "Fits your channel · Caylus · 5.3M", or what kind of idea Chumoku found.
struct MetaLine: View {
    let idea: Idea
    var body: some View {
        Group {
            if !idea.isOwn && idea.fit == "yes" {
                Text("\(Text("Fits your channel").foregroundStyle(Color.process))\(idea.cardMeta.isEmpty ? "" : " · \(idea.cardMeta)")")
                    .foregroundStyle(Color.textFaint)
            } else {
                Text(idea.cardMeta).foregroundStyle(Color.textFaint)
            }
        }
        .font(.geist(12))
        .lineLimit(1)
    }
}

// A Short's thumbnail arrives letterboxed in 16:9; scaling it up crops the
// bars away, the same trick the web cards use.
struct Thumb: View {
    let url: URL?
    var radius: CGFloat = Radius.md

    var body: some View {
        Color.raised
            .overlay {
                AsyncImage(url: url, transaction: Transaction(animation: .easeOut(duration: 0.25))) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill().scaleEffect(1.35)
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Color.line, lineWidth: 1))
    }
}

struct Empty: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.tSmall)
            .foregroundStyle(Color.textMuted)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 24)
            .padding(.vertical, 48)
            .background(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).fill(Color.raised))
            .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Color.line, lineWidth: 1))
    }
}

// "New ideas in 5h · unsaved ones disappear", ticking down.
struct Countdown: View {
    let until: Date
    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { ctx in
            let s = max(0, Int(until.timeIntervalSince(ctx.date)))
            let left = s >= 3600 ? "\(s / 3600)h \((s % 3600) / 60)m" : "\(max(1, s / 60))m"
            Text("New ideas in \(left)")
                .font(.tSmall)
                .foregroundStyle(Color.textFaint)
                .lineLimit(1)
        }
    }
}
