import SwiftUI
import Charts
import Supabase

// The owner's overview, the same numbers as the web's Admin page
// (src/components/AdminPage.tsx), from admin-stats, which refuses anyone but
// the owner. Money first, then people, then the plan mix.
nonisolated struct AdminStats: Decodable {
    let total_users: Int
    let new_users_today: Int
    let new_users_28d: Int
    let active_users_28d: Int
    let active_users_today: Int
    let active_users_7d: Int
    let daily_active: [Int]
    let daily_signups: [Int]
    let plan_free: Int
    let plan_plus: Int
    let plan_pro: Int
    let new_subs_today: Int
    let new_subs_28d: Int
    let cancels_28d: Int
    let revenue_28d_cents: Int
    let daily_subs: [Int]
}

enum Owner {
    static let email = "reyzostyle@gmail.com"
}

struct AdminView: View {
    @State private var stats: AdminStats?
    @State private var failed = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if let s = stats {
                    // Monthly billing assumed, as on the web: yearly plans
                    // are not recorded separately.
                    let mrr = Double(s.plan_plus) * 29 + Double(s.plan_pro) * 49
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                        tile("MRR", money(mrr), "\(s.plan_plus + s.plan_pro) paying")
                        tile("Revenue 28d", money(Double(s.revenue_28d_cents) / 100), "\(s.new_subs_28d) new · \(s.cancels_28d) cancelled")
                        tile("Active today", "\(s.active_users_today)", "\(s.active_users_7d) this week")
                        tile("Users", s.total_users.formatted(), "+\(s.new_users_today) today")
                    }
                    chart("Signups", "\(s.daily_signups.reduce(0, +))", "last 28 days", s.daily_signups)
                    chart("Active users", "\(s.active_users_28d)", "opened it in the last 28 days", s.daily_active)
                    chart("New subscriptions", "\(s.daily_subs.reduce(0, +))", "\(s.new_subs_today) today", s.daily_subs)
                    plans(s)
                } else if failed {
                    Text("Could not load the numbers.").font(.tSmall).foregroundStyle(Color.danger)
                } else {
                    ForEach(0..<4, id: \.self) { _ in Skeleton().frame(height: 96) }
                }
            }
            .padding(20)
        }
        .background(Color.bg.ignoresSafeArea())
        .navigationTitle("Admin")
        .toolbar(.visible, for: .navigationBar)
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        do {
            stats = try await supabase.functions.invoke("admin-stats", options: FunctionInvokeOptions(method: .get))
            failed = false
        } catch {
            failed = stats == nil
        }
    }

    private func money(_ n: Double) -> String { n.formatted(.currency(code: "USD").precision(.fractionLength(n < 100 ? 2 : 0))) }

    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) { content() }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).fill(Color.raised))
            .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Color.line, lineWidth: 1))
    }

    private func tile(_ label: String, _ value: String, _ sub: String) -> some View {
        card {
            Text(verbatim: label).font(.tLabel).foregroundStyle(Color.textMuted)
            Text(verbatim: value).font(.geist(24, .medium)).foregroundStyle(Color.text).monospacedDigit().lineLimit(1).minimumScaleFactor(0.6)
            Text(verbatim: sub).font(.geist(11)).foregroundStyle(Color.textFaint).lineLimit(1)
        }
    }

    private func chart(_ label: String, _ total: String, _ sub: String, _ values: [Int]) -> some View {
        card {
            Text(verbatim: label).font(.tLabel).foregroundStyle(Color.textMuted)
            Text(verbatim: total).font(.geist(24, .medium)).foregroundStyle(Color.text).monospacedDigit()
            Text(verbatim: sub).font(.geist(11)).foregroundStyle(Color.textFaint)
            Chart(Array(values.enumerated()), id: \.offset) { i, v in
                BarMark(x: .value("Day", i), y: .value(label, v))
                    .foregroundStyle(i == values.count - 1 ? Color.white : Color.white.opacity(0.25))
                    .cornerRadius(2)
            }
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .frame(height: 80)
            .padding(.top, 10)
        }
    }

    private func plans(_ s: AdminStats) -> some View {
        let total = max(1, s.total_users)
        let share = { (n: Int) in CGFloat(n) / CGFloat(total) }
        return card {
            Text("Plans").font(.tLabel).foregroundStyle(Color.textMuted)
            GeometryReader { g in
                HStack(spacing: 0) {
                    Rectangle().fill(Color.white).frame(width: g.size.width * share(s.plan_pro))
                    Rectangle().fill(Color.white.opacity(0.45)).frame(width: g.size.width * share(s.plan_plus))
                    Spacer(minLength: 0)
                }
                .background(Color.white.opacity(0.08))
                .clipShape(Capsule())
            }
            .frame(height: 8)
            .padding(.vertical, 10)
            HStack(alignment: .top) {
                ForEach([("Pro", s.plan_pro), ("Plus", s.plan_plus), ("Trial", s.plan_free)], id: \.0) { name, n in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: name).font(.tSmall).foregroundStyle(Color.textMuted)
                        Text(verbatim: n.formatted()).font(.geist(20, .medium)).foregroundStyle(Color.text).monospacedDigit()
                        Text(verbatim: "\(Int((share(n) * 100).rounded()))%").font(.geist(11)).foregroundStyle(Color.textFaint)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}
