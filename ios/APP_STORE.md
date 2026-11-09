# Chumoku on the App Store: launch checklist

State on 2026-10-30. What is in code is done and builds (Debug and Release).
Everything below the line "Ivan" needs the paid Developer account or a click
in a dashboard.

## Done in code

- Ideas, Chat, Settings (the web's settings, minus Stripe cancel, codes and
  affiliate). Filming and the editor are hidden (`Features.filming = false`).
- Sign in with Apple, email, Google. Account deletion in the app, including
  revoking the Apple grant once the key below is set.
- In-app purchases (StoreKit 2): Plus and Pro, monthly and yearly, and a
  50-credit top-up. Checked server-side against Apple's signature
  (`apple-iap`), renewals and refunds through `apple-notifications`. The plans
  open by themselves when credits run out.
- English, Spanish, Brazilian Portuguese, French, German, Japanese. Ideas,
  scripts and the chat come back in the language picked in Settings
  (default: the phone's).
- `PrivacyInfo.xcprivacy`, `ITSAppUsesNonExemptEncryption = NO`, version 1.0.0
  build 1, `Chumoku.storekit` for testing purchases in the simulator.

## Server (one command each, needs a yes)

1. Migrations, in this order, in the SQL editor (not `db push`, see memory):
   `20261030000000_lock_user_tokens_paid_columns.sql`,
   `20261030010000_apple_iap.sql`, `20261030020000_user_language.sql`.
   The first one closes a hole that exists today on the web too: any signed-in
   user can set their own `plan` and `credits_used` from the browser console.
2. Deploy: `apple-iap`, `apple-notifications --no-verify-jwt`, `delete-account`,
   and every function that now reads the language: `write-script`,
   `chat-followup`, `steal-video`, `generate-outline`,
   `enrich-competitor-video`, `daily-ideas`, `build-brain`, `sync-retention`,
   `analyze-upload`, `analyze-with-gemini`, `pitch-ideas`.

## Ivan, after buying the Developer Program

1. **Team.** Put the new Team ID in `ios/project.yml` (`DEVELOPMENT_TEAM`), run
   `xcodegen generate`. Trust the new certificate on the iPhone once.
2. **Agreements.** App Store Connect → Business: sign the Paid Apps agreement,
   add bank and tax info. In-app purchases do not load at all until this is
   done. Apply for the Small Business Program (15% instead of 30%).
3. **The app.** App Store Connect → Apps → New: iOS, name `Chumoku`, bundle
   `co.chumoku.app`, SKU `chumoku-ios`, primary language English (U.S.).
   Copy its Apple ID (a number, App Information) into the Supabase secret
   `APPLE_APP_ID`. Until it is set only TestFlight/sandbox purchases verify.
4. **Purchases.** Monetization → Subscriptions → group `Chumoku`:
   | Product ID | Name | Price | Level |
   |---|---|---|---|
   | `co.chumoku.app.pro.monthly` | Pro | $49 / month | 1 |
   | `co.chumoku.app.pro.yearly` | Pro | $299 / year | 1 |
   | `co.chumoku.app.plus.monthly` | Plus | $29 / month | 2 |
   | `co.chumoku.app.plus.yearly` | Plus | $149 / year | 2 |

   In-App Purchases → Consumable `co.chumoku.app.credits50`, "50 credits",
   $4.99. Each one needs a display name, a one-line description and a review
   screenshot (the Plans screen). Prices are the web's; Apple keeps 15%.
5. **Notifications.** App Information → App Store Server Notifications, V2,
   production and sandbox both:
   `https://ezlousklksipvwuinpzq.supabase.co/functions/v1/apple-notifications`
6. **Sign in with Apple key.** Certificates, IDs & Profiles → Keys → new key
   with Sign in with Apple, for `co.chumoku.app`. Secrets:
   `APPLE_TEAM_ID`, `APPLE_SIGNIN_KEY_ID`, `APPLE_SIGNIN_PRIVATE_KEY` (the
   .p8 file's text). Without it, deleting an account still works but the
   Apple grant is not revoked, which review can flag.
7. **Google sign-in.** Supabase → Auth → URL Configuration → Redirect URLs
   must contain `chumoku://auth-callback`, or the Google button fails in the
   app and review rejects it (2.1). Check before submitting.
8. **Review account.** An email/password account with a built brain, a few
   saved ideas and Plus, so the reviewer sees everything without connecting
   YouTube. Put it in Review Notes (below).
9. **Sandbox tester.** Users and Access → Sandbox → a test Apple ID, signed in
   on the iPhone under Settings → Developer, to buy without paying.
10. **Upload.** Xcode → Product → Archive → Distribute App → App Store Connect.
    TestFlight first, buy each product once with the sandbox tester, then
    submit.

## Store page

Screenshots: 6.9" (1320 × 2868) is required, at least 3. Ideas grid, an idea
with its script, the chat, Plans. Take them on the iPhone 17 Pro Max simulator
signed in to the review account.

URLs: privacy `https://chumoku.co/privacy`, support `https://chumoku.co`,
marketing `https://chumoku.co`. Terms: Apple's standard EULA (linked on the
Plans screen).

Category: Productivity (secondary: Photo & Video). Age rating: answer "no" to
everything; the chat is about the creator's own channel and makes no
unmoderated content public.

App Privacy (matches `PrivacyInfo.xcprivacy`): Email, Name, User ID, Purchase
History, Other User Content, Product Interaction. All linked to the user, all
App Functionality, none used for tracking.

### English (U.S.)

- **Name:** Chumoku
- **Subtitle:** Know what to film every day
- **Promotional text:** New ideas every morning, picked from Shorts that just beat their channel and remade for yours. One press turns any of them into a script in your voice.
- **Keywords:** shorts,youtube,ideas,script,creator,content,tiktok,reels,hooks,viral,planner,writer,video
- **Description:**

  Every morning Chumoku finds Shorts that just did far better than their channel usually does, and turns each one into an idea for your channel: same format, your subject, your audience.

  Like one, and a press writes the script in the way you actually talk, built from your own uploads. Ask the chat anything about your channel, an idea or a draft, and it answers knowing what has worked for you before.

  - Ideas every day, picked for your niche
  - A script from any idea in one press
  - A chat that knows your channel and your numbers
  - Follow the channels you want to learn from
  - Works in English, Spanish, Portuguese, French, German and Japanese

  The daily ideas are free. Plus and Pro add credits for scripts and the chat.

### Spanish (Mexico and Spain)

- **Subtitle:** Ideas para Shorts cada día
- **Keywords:** shorts,youtube,ideas,guion,creador,contenido,tiktok,reels,viral,ganchos,videos
- **Promotional text:** Ideas nuevas cada mañana, sacadas de Shorts que superaron a su canal y adaptadas al tuyo. Un toque y tienes el guion con tu voz.

### Portuguese (Brazil)

- **Subtitle:** Ideias de Shorts todo dia
- **Keywords:** shorts,youtube,ideias,roteiro,criador,conteúdo,tiktok,reels,viral,ganchos,vídeos
- **Promotional text:** Ideias novas toda manhã, tiradas de Shorts que superaram o próprio canal e adaptadas ao seu. Um toque e o roteiro sai com a sua voz.

### French

- **Subtitle:** Idées de Shorts chaque jour
- **Keywords:** shorts,youtube,idées,script,créateur,contenu,tiktok,reels,viral,accroches,vidéo
- **Promotional text:** De nouvelles idées chaque matin, tirées de Shorts qui ont battu leur chaîne et refaites pour la tienne. Un geste et le script est écrit avec ta voix.

### German

- **Subtitle:** Jeden Tag Ideen für Shorts
- **Keywords:** shorts,youtube,ideen,skript,creator,content,tiktok,reels,viral,hooks,video
- **Promotional text:** Jeden Morgen neue Ideen aus Shorts, die ihren Kanal geschlagen haben, umgebaut für deinen. Ein Tipp, und das Skript steht in deiner Stimme.

### Japanese

- **Subtitle:** 毎日のショート動画ネタ
- **Keywords:** ショート,YouTube,ネタ,台本,クリエイター,動画,TikTok,リール,バズ,企画
- **Promotional text:** 毎朝、チャンネル平均を大きく超えたShortsから、あなたのチャンネル向けのネタを届けます。ワンタップで、あなたの話し方の台本に。

The long description for the five languages: paste the English into App Store
Connect's translate field or ask for it; the short fields above are the ones
search reads.

### Review notes

Chumoku gives YouTube Shorts creators video ideas every day and writes scripts for them.

Demo account: <email> / <password> (Plus plan, profile already set up).

- Ideas tab: today's ideas. Tap one, then "Write my script" (uses credits).
- Chat tab: ask about the channel or an idea.
- Settings → Plan: the subscriptions and the credit top-up, all through In-App Purchase.
- Settings → Delete account: deletes the account and all its data.
- Connecting YouTube is optional and read-only (youtube.readonly, yt-analytics.readonly).

People who subscribed on our website keep that plan when they sign in here; the app never links to or mentions purchasing outside the App Store.
