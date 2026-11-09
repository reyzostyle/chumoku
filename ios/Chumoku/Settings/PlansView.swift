import SwiftUI
import StoreKit
import Supabase

// The plans and extra credits, bought through Apple. Same two plans and the
// same top-up as the web's Upgrade page; prices come from the App Store in the
// buyer's currency.
//
// Redone 2026-10-30 after Ivan's "looks ahhh, and no extra credits": one plan
// picked at a time like a radio list, one button at the bottom, and extra
// credits always on the page (not only once the App Store has answered).
struct PlansView: View {
    var embedded = false
    @Environment(AuthModel.self) private var auth
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    private var store: Purchases { Purchases.shared }

    @State private var yearly = false
    @State private var picked = "pro"   // database name: 'pro' is Plus, 'agency' is Pro
    @State private var plan: String?
    @State private var applePlan: String?

    // What the App Store will say, shown until it does (and when it cannot be
    // reached), so the page never opens on empty price slots.
    private static let fallback: [String: Decimal] = [
        Purchases.plusMonthly: 29, Purchases.plusYearly: 149,
        Purchases.proMonthly: 49, Purchases.proYearly: 299,
        Purchases.credits50: 15,
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text("Choose a plan").font(.tTitle).foregroundStyle(Color.text)

                    Seg(options: [(false, String(localized: "Monthly")), (true, String(localized: "Yearly"))], value: $yearly)
                        .padding(.top, 20)

                    VStack(spacing: 10) {
                        planCard(db: "pro", name: "Plus", scripts: String(localized: "About 30 scripts a month"))
                        planCard(db: "agency", name: "Pro", scripts: String(localized: "About 100 scripts a month"))
                    }
                    .padding(.top, 16)

                    VStack(alignment: .leading, spacing: 8) {
                        bullet(String(localized: "A chat that knows your channel"))
                        bullet(String(localized: "Scripts in your voice, from any idea"))
                        bullet(String(localized: "Track up to 5 channels"))
                    }
                    .padding(.top, 18)
                    .padding(.horizontal, 4)

                    Text("Extra credits").font(.tLabel).foregroundStyle(Color.textMuted)
                        .padding(.top, 32).padding(.leading, 4)
                    extraCredits.padding(.top, 10)

                    if store.loadFailed && store.products.isEmpty {
                        HStack(spacing: 6) {
                            Text("Couldn't reach the App Store.").foregroundStyle(Color.textFaint)
                            Button("Try again") { Task { await store.load() } }.foregroundStyle(Color.text).buttonStyle(.plain)
                        }
                        .font(.tSmall)
                        .padding(.top, 14)
                    }
                    if let m = store.message {
                        Text(m).font(.tSmall).foregroundStyle(Color.textMuted).padding(.top, 14)
                    }

                    // What the App Store requires next to any subscription.
                    Text("Plans renew automatically at the price shown until you cancel. Cancel any time in your Apple ID's subscription settings, at least 24 hours before the period ends. Payment is charged to your Apple ID.")
                        .font(.geist(12)).foregroundStyle(Color.textFaint)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 28)
                    HStack(spacing: 16) {
                        Button("Restore purchases") { Task { await store.restore(); await loadPlan() } }
                        Button("Terms of Use") { open("https://www.apple.com/legal/internet-services/itunes/dev/stdeula/") }
                        Button("Privacy") { open("https://chumoku.co/privacy") }
                    }
                    .font(.geist(12, .medium)).foregroundStyle(Color.textMuted).buttonStyle(.plain)
                    .padding(.top, 12)
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .safeAreaInset(edge: .bottom) { cta }
            .background(Color.bg.ignoresSafeArea())
            .toolbar {
                if !embedded {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                }
                }
            }
        }
        .preferredColorScheme(.dark)
        .task {
            if store.products.isEmpty { await store.load() }
            await loadPlan()
        }
        .onChange(of: store.changed) { Task { await loadPlan() } }
    }

    // MARK: pieces

    private func id(_ db: String) -> String {
        db == "agency" ? (yearly ? Purchases.proYearly : Purchases.proMonthly)
                       : (yearly ? Purchases.plusYearly : Purchases.plusMonthly)
    }

    private func price(_ id: String) -> Decimal { store.products[id]?.price ?? Self.fallback[id] ?? 0 }

    private func format(_ amount: Decimal, like id: String) -> String {
        if let p = store.products[id] { return amount.formatted(p.priceFormatStyle) }
        return amount.formatted(.currency(code: "USD"))
    }

    private func displayPrice(_ id: String) -> String {
        store.products[id]?.displayPrice ?? format(price(id), like: id)
    }

    private func planCard(db: String, name: String, scripts: String) -> some View {
        let pid = id(db)
        let on = picked == db
        let current = plan == db
        // Yearly is shown per month, which is how people compare.
        let perMonth = yearly ? price(pid) / 12 : price(pid)
        return Button { withAnimation(.ui) { picked = db } } label: {
            HStack(alignment: .center, spacing: 14) {
                ZStack {
                    Circle().strokeBorder(on ? Color.white : Color.lineStrong, lineWidth: 1.5).frame(width: 22, height: 22)
                    if on { Circle().fill(Color.white).frame(width: 12, height: 12) }
                }
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Text(verbatim: name).font(.geist(18, .medium)).foregroundStyle(Color.text)
                        if current {
                            Text("Your plan").font(.geist(11, .medium)).foregroundStyle(Color.bg)
                                .padding(.horizontal, 7).padding(.vertical, 3)
                                .background(Capsule().fill(Color.white))
                        }
                    }
                    Text(scripts).font(.tSmall).foregroundStyle(Color.textMuted)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(verbatim: format(perMonth, like: pid)).font(.geist(18, .medium)).foregroundStyle(Color.text).monospacedDigit()
                    Text(yearly ? String(localized: "a month, \(displayPrice(pid)) a year") : String(localized: "a month"))
                        .font(.geist(11)).foregroundStyle(Color.textFaint)
                }
            }
            .padding(16)
            .background(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).fill(Color.raised))
            .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
                .strokeBorder(on ? Color.white : Color.line, lineWidth: on ? 1.5 : 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.selection, trigger: picked)
    }

    private func bullet(_ s: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Color.textMuted).padding(.top, 3)
            Text(s).font(.tSmall).foregroundStyle(Color.text)
        }
    }

    // Always on the page. Top-ups are for subscribers (at the same price per
    // credit, selling them on free would undercut Plus), so on free it says so.
    private var extraCredits: some View {
        let subscribed = (plan ?? "free") != "free"
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text("50 credits").font(.geist(16, .medium)).foregroundStyle(Color.text)
                Text(subscribed ? String(localized: "On top of your plan. They don't expire.") : String(localized: "With Plus or Pro. They don't expire."))
                    .font(.tSmall).foregroundStyle(Color.textMuted)
            }
            Spacer()
            Button {
                guard let uid = auth.user?.id else { return }
                Task { await store.buy(Purchases.credits50, for: uid) }
            } label: {
                HStack(spacing: 6) {
                    if store.buying == Purchases.credits50 { ProgressView().controlSize(.small) }
                    Text(verbatim: displayPrice(Purchases.credits50))
                }
                .font(.geist(14, .medium)).foregroundStyle(Color.text)
                .padding(.horizontal, 16).frame(height: 36)
                .background(Capsule().fill(Color.white.opacity(0.1)))
            }
            .buttonStyle(.plain)
            .disabled(!subscribed || store.buying != nil || store.products[Purchases.credits50] == nil)
            .opacity(subscribed ? 1 : 0.4)
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).fill(Color.raised))
        .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Color.line, lineWidth: 1))
    }

    // One button for whatever is picked.
    private var cta: some View {
        let pid = id(picked)
        let isCurrent = applePlan == pid || (plan == picked && applePlan == nil && (plan ?? "free") != "free")
        let name = picked == "agency" ? "Pro" : "Plus"
        return VStack(spacing: 0) {
            Button {
                guard let uid = auth.user?.id else { return }
                Task { await store.buy(pid, for: uid) }
            } label: {
                HStack(spacing: 8) {
                    if store.buying == pid { ProgressView().controlSize(.small).tint(Color.bg) }
                    Text(isCurrent ? String(localized: "Your plan") : String(localized: "Get \(name) · \(displayPrice(pid))"))
                }
            }
            .buttonStyle(.pill)
            .disabled(isCurrent || store.buying != nil || store.products[pid] == nil)
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 8)
        .background(Color.bg.opacity(0.94).ignoresSafeArea(edges: .bottom))
    }

    private func open(_ s: String) { if let u = URL(string: s) { openURL(u) } }

    private func loadPlan() async {
        nonisolated struct Row: Decodable { let plan: String?; let apple_product_id: String?; let apple_expires_at: String? }
        guard let uid = auth.user?.id else { return }
        let row: Row? = try? await supabase.from("user_tokens").select("plan, apple_product_id, apple_expires_at")
            .eq("user_id", value: uid).single().execute().value
        plan = row?.plan ?? "free"
        let live = row?.apple_expires_at.flatMap(ISO8601DateFormatter.flexible).map { $0 > .now } ?? false
        applePlan = live ? row?.apple_product_id : nil
        if let a = applePlan { yearly = a.hasSuffix("yearly") }
        // Open on the plan they are on, or Plus.
        if plan == "agency" { picked = "agency" }
    }
}
