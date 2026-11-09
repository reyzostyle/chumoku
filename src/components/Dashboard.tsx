import { useState, useEffect, lazy, Suspense } from 'react';
import { AppShell, NavTab, HIDDEN_TABS, OWNER_EMAIL, OWNER_ONLY_TABS } from './AppShell';
import { useAuth } from '../contexts/AuthContext';
import { HomePage } from './HomePage';
import { AnalysisChat } from './AnalysisChat';
import { SavedPage } from './SavedPage';
import { RetentionPage } from './RetentionPage';
import { UpgradePage } from './UpgradePage';
import { SettingsPage } from './SettingsPage';
import { PartnersPage } from './PartnersPage';
import { PartnersAdminPage } from './PartnersAdminPage';
import { CompetitorsPage } from './CompetitorsPage';
import { AdminPage } from './AdminPage';
import { ShareChooser } from './ShareChooser';
import { useUsage } from '../lib/useUsage';
import { peek, take, PENDING_ANALYZE_KEY, PENDING_STEAL_KEY, PENDING_SHARE_KEY, OPEN_RETENTION_KEY } from '../lib/intents';

// Loaded on first open: the editor pulls in a video decoder/encoder that no
// other screen needs.
const EditPage = lazy(() => import('./EditPage'));

// 'admin' is intentionally reachable but has no sidebar entry (see AppShell) —
// only reached by entering the admin code in Settings. AdminPage itself
// re-checks the caller's email before rendering anything or fetching data.
// 'home' also has no nav entry: it's reached from the brand row in the sidebar.
const VALID_TABS: NavTab[] = ['home', 'analyze', 'saved', 'retention', 'competitors', 'edit', 'upgrade', 'partners', 'settings', 'admin', 'affiliate-admin'];

// Tabs removed on 2026-09-29, and where anything still asking for them lands:
// Projects became Saved, Analytics' channel numbers moved into Settings.
const RETIRED_TABS: Record<string, NavTab> = { projects: 'saved', analytics: 'settings' };

// A tab is reachable only if it's known and not feature-flagged off.
const isTabReachable = (t: string): t is NavTab =>
  (VALID_TABS as string[]).includes(t) && !HIDDEN_TABS.includes(t as NavTab);

const OPEN_WITHOUT_PLAN: NavTab[] = ['upgrade', 'settings', 'partners', 'admin', 'affiliate-admin'];

export function Dashboard() {
  const { user } = useAuth();
  const isOwner = user?.email === OWNER_EMAIL;
  // Always opens on the hub rather than restoring the last tab: it's where
  // new tools and announcements surface, so it's what should greet you on
  // every entry. (Deliberately not persisted — a reload lands here too.)
  // Exception: a URL pasted into the landing page's hero before signing up
  // is waiting in localStorage for AnalysisChat to pick it up — go straight
  // there instead of stranding it on the hub. This also carries the link
  // across onboarding: Dashboard mounts after it, and the key is still set.
  // A Steal from the extension or the share sheet goes to Ideas the same way,
  // where CompetitorsPage picks it up, and a review's "See where people left"
  // from the extension to Retention.
  const [activeTab, setActiveTab] = useState<NavTab>(
    () => (peek(PENDING_ANALYZE_KEY) ? 'analyze' : peek(PENDING_STEAL_KEY) ? 'competitors' : peek(OPEN_RETENTION_KEY) ? 'retention' : 'home')
  );

  // A link shared from a phone arrives without saying what it is for.
  const [shared, setShared] = useState<string | null>(() => take(PENDING_SHARE_KEY));

  // Subscribers only since 2026-11-09. Without a plan: the plans, and Settings
  // for signing out or deleting the account. Nothing renders until the plan is
  // known, or Ideas would flash and ask the server for a drop.
  const { usage, loading: usageLoading, reload: reloadUsage } = useUsage();
  const locked = usage?.plan === 'free';
  const tab: NavTab = locked && !OPEN_WITHOUT_PLAN.includes(activeTab) ? 'upgrade' : activeTab;

  // Back from Stripe the webhook can still be on its way.
  useEffect(() => {
    if (!locked || !new URLSearchParams(window.location.search).get('checkout')) return;
    const t = setInterval(reloadUsage, 2000);
    const stop = setTimeout(() => clearInterval(t), 30_000);
    return () => { clearInterval(t); clearTimeout(stop); };
  }, [locked, reloadUsage]);
  const chooseShared = (action: 'analyze' | 'steal') => {
    if (!shared) return;
    localStorage.setItem(action === 'analyze' ? PENDING_ANALYZE_KEY : PENDING_STEAL_KEY, shared);
    setShared(null);
    // Both screens read their key on mount, so leave and re-enter even if the
    // tab is already the right one.
    const tab: NavTab = action === 'analyze' ? 'analyze' : 'competitors';
    setActiveTab('home');
    setTimeout(() => setActiveTab(tab), 0);
  };

  useEffect(() => {
    const handler = (e: Event) => {
      // 'usage' was a tab until the balance moved into Settings. Anything that
      // still asks for it lands on the Credits card instead of nowhere.
      if ((e as CustomEvent).detail === 'usage') {
        try { localStorage.setItem('chumoku_open_settings', 'credits'); } catch { /* ignore */ }
        setActiveTab('settings');
        return;
      }
      const asked = (e as CustomEvent).detail as string;
      const tab = RETIRED_TABS[asked] ?? asked;
      if (tab && isTabReachable(tab) && (isOwner || !OWNER_ONLY_TABS.includes(tab))) setActiveTab(tab);
    };
    window.addEventListener('chumoku:navigate', handler);
    return () => window.removeEventListener('chumoku:navigate', handler);
  }, [isOwner]);

  // Handle return from Notion OAuth (callback redirects to /?notion=connected|error)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const notion = params.get('notion');
    if (!notion) return;
    import('../lib/toast').then(({ showToast }) => {
      if (notion === 'connected') { showToast('Notion connected ✓'); setActiveTab('settings'); }
      else showToast('Notion connection failed', 'error');
    });
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  return (
    <AppShell activeTab={tab} onTabChange={setActiveTab}>
      {(usage || !usageLoading) && <>
      {tab === 'home' && <HomePage onNavigate={setActiveTab} />}
      {tab === 'analyze' && <AnalysisChat />}
      {tab === 'saved' && <SavedPage />}
      {tab === 'retention' && <RetentionPage />}
      {tab === 'edit' && isOwner && <Suspense fallback={null}><EditPage /></Suspense>}
      {tab === 'competitors' && <CompetitorsPage />}
      {tab === 'upgrade' && <UpgradePage />}
      {tab === 'partners' && <PartnersPage />}
      {tab === 'affiliate-admin' && <PartnersAdminPage />}
      {tab === 'settings' && <SettingsPage />}
      {tab === 'admin' && <AdminPage />}
      {shared && <ShareChooser url={shared} onChoose={chooseShared} onClose={() => setShared(null)} />}
      </>}
    </AppShell>
  );
}
