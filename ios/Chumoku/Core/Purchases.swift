import StoreKit
import Supabase

// In-app purchases (StoreKit 2). The same plans and top-up as chumoku.co, sold
// through Apple: an app may not point at payment anywhere else (3.1.1).
//
// Every transaction goes to apple-iap as Apple signed it, and is finished only
// once the server has put it on the account. One that fails to get there
// (offline, signed out) stays unfinished, and StoreKit hands it back through
// Transaction.updates on the next launch.
@Observable
final class Purchases {
    static let shared = Purchases()

    static let plusMonthly = "co.chumoku.app.plus.monthly"
    static let plusYearly = "co.chumoku.app.plus.yearly"
    static let proMonthly = "co.chumoku.app.pro.monthly"
    static let proYearly = "co.chumoku.app.pro.yearly"
    static let credits50 = "co.chumoku.app.credits50"
    static let all = [plusMonthly, plusYearly, proMonthly, proYearly, credits50]

    var products: [String: Product] = [:]
    var loadFailed = false
    var buying: String?
    var restoring = false
    var message: String?
    // Raised by anything that ran out of credits; MainTabs shows the plans.
    var showPlans = false
    // Bumped after a purchase lands, so screens showing the balance reload.
    var changed = 0
    // The account's plan ('free', 'pro', 'agency'), for the Upgrade buttons.
    var plan: String?

    private var updates: Task<Void, Never>?

    func start() {
        guard updates == nil else { return }
        updates = Task {
            for await result in Transaction.updates { await report(result) }
        }
        Task { await load() }
    }

    func load() async {
        do {
            let list = try await Product.products(for: Self.all)
            products = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
            loadFailed = list.isEmpty
        } catch {
            loadFailed = true
        }
    }

    func buy(_ id: String, for user: UUID) async {
        guard let product = products[id] else { return }
        buying = id
        message = nil
        defer { buying = nil }
        do {
            // The account id rides along inside the signed transaction, so
            // renewals Apple reports later land on the right account.
            switch try await product.purchase(options: [.appAccountToken(user)]) {
            case .success(let result): await report(result)
            case .pending: message = String(localized: "Waiting for approval. It'll show up here once it goes through.")
            case .userCancelled: break
            @unknown default: break
            }
        } catch {
            message = String(localized: "The purchase didn't go through. Try again.")
        }
    }

    func restore() async {
        restoring = true
        message = nil
        defer { restoring = false }
        do { try await AppStore.sync() } catch { return }
        var any = false
        for await result in Transaction.currentEntitlements {
            any = true
            await report(result)
        }
        if !any { message = String(localized: "Nothing to restore on this Apple ID.") }
    }

    // The subscription this Apple ID has with the app right now, if any.
    func activeSubscription() async -> String? {
        for await result in Transaction.currentEntitlements {
            if case .verified(let t) = result, t.productType == .autoRenewable, t.revocationDate == nil { return t.productID }
        }
        return nil
    }

    func refreshPlan() async {
        nonisolated struct Row: Decodable { let plan: String? }
        #if DEBUG
        if IdeasStore.isDemo { plan = ProcessInfo.processInfo.arguments.contains("-locked") ? "free" : "pro"; return }
        #endif
        guard let uid = try? await supabase.auth.session.user.id else { plan = nil; return }
        let row: Row? = try? await supabase.from("user_tokens").select("plan").eq("user_id", value: uid).single().execute().value
        plan = row?.plan ?? "free"
    }

    private func report(_ result: VerificationResult<Transaction>) async {
        nonisolated struct Failed: Decodable { let error: String? }
        guard case .verified(let transaction) = result else {
            message = String(localized: "Apple couldn't verify that purchase.")
            return
        }
        do {
            try await supabase.functions.invoke("apple-iap", options: FunctionInvokeOptions(body: ["jws": result.jwsRepresentation]))
            await transaction.finish()
            changed += 1
            await refreshPlan()
        } catch let FunctionsError.httpError(code, data) {
            let text = (try? JSONDecoder().decode(Failed.self, from: data))?.error
            message = text ?? String(localized: "Paid, but it hasn't reached your account yet. It will on the next launch.")
            // Refused for good (someone else's purchase): finishing it stops it
            // coming back on every launch. Anything else is retried.
            if code == 403 || code == 409 { await transaction.finish() }
        } catch {
            message = String(localized: "Paid, but it hasn't reached your account yet. It will on the next launch.")
        }
    }
}
