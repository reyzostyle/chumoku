import { useState, useEffect, createContext, useRef } from 'react';
import { SettingsOutlineIcon as Settings, LogoutOutlineIcon as LogOut, BoltOutlineIcon as Zap, LightbulbOutlineIcon as Bulb, ChatRoundOutlineIcon as Chat, BookmarkOutlineIcon as Bookmark, SidebarMinimalisticOutlineIcon as PanelLeftClose, SidebarMinimalisticOutlineIcon as PanelLeftOpen, WidgetOutlineIcon as HubIcon, ClapperboardEditOutlineIcon as EditIcon } from '@solar-icons/react';
import { useAuth } from '../contexts/AuthContext';

export const MobileHeaderContext = createContext<{
  setRightAction: (node: React.ReactNode) => void;
}>({ setRightAction: () => {} });

export type NavTab = 'home' | 'analyze' | 'saved' | 'retention' | 'competitors' | 'edit' | 'upgrade' | 'settings' | 'partners' | 'admin' | 'affiliate-admin';

// Vibe editing is the owner's alone while it is being proven (2026-10-20).
// The edit-plan function re-checks the email server-side; this only hides the
// door.
export const OWNER_EMAIL = 'reyzostyle@gmail.com';
export const OWNER_ONLY_TABS: NavTab[] = ['edit'];

// Feature flags: tabs hidden from ALL users (incl. admin). Kept in code so they
// can be re-enabled instantly by removing them from this list.
// 'edit': the web editor, hidden 2026-10-28 (Ivan); editing lives in the iOS
// app now. Still openable in dev at /lab/edit.
export const HIDDEN_TABS: NavTab[] = ['edit'];

interface NavItem {
  id: NavTab;
  label: string;
  icon: React.ReactNode;
  highlight?: boolean;
  badge?: string;
}

interface AppShellProps {
  activeTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  children: React.ReactNode;
}

// One flat list. The Analyze sub-panel used to hold Video/Hook/Script in a
// second column, which cost a whole column on desktop and had nowhere sensible
// to live on a phone. They are tabs like everything else now.
const MOBILE_TABS: { id: NavTab; label: string; icon: typeof Bulb }[] = [
  { id: 'competitors', label: 'Ideas', icon: Bulb },
  { id: 'analyze', label: 'Chat', icon: Chat },
  { id: 'saved', label: 'Saved', icon: Bookmark },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const baseNavItems: NavItem[] = [
  // Ideas first: the product is ideas you steal, then talk through, then keep
  // (2026-09-29). Analytics and Projects were removed that day - the radar was
  // built from the out-of-100 score the chat no longer gives, and Projects were
  // folders nobody needed once saved ideas carry their own chats.
  //
  // Labelled Ideas, id still `competitors`, and Chat, id still `analyze` - the
  // ids are persisted in state, dispatched on the navigate channel and matched
  // in the DB, and renaming an identifier to match a caption is how those
  // quietly come apart.
  { id: 'competitors', label: 'Ideas', icon: <Bulb className="w-4 h-4" /> },
  { id: 'analyze', label: 'Chat', icon: <Chat className="w-4 h-4" /> },
  { id: 'saved', label: 'Saved', icon: <Bookmark className="w-4 h-4" /> },
  // Retention had a tab here from 2026-10-28 to 10-30. Ivan: the point was
  // for the chat and the scripts to know it, and a screen of every curve was
  // one more thing to read. The lessons feed every prompt (brainBlock), the
  // brain card in Settings shows them, and a review of their own Short still
  // links to its curve.
  { id: 'edit', label: 'Edit', icon: <EditIcon className="w-4 h-4" /> },
  { id: 'upgrade', label: 'Upgrade', icon: <Zap className="w-4 h-4" />, highlight: true },
  { id: 'settings', label: 'Settings', icon: <Settings className="w-4 h-4" /> },
];


const SIDEBAR_COLLAPSED_KEY = 'chumoku_sidebar_collapsed';

export function AppShell({ activeTab, onTabChange, children }: AppShellProps) {
  const { user, signOut } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');
  const [, setRightAction] = useState<React.ReactNode>(null);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const onTouchMove = (e: TouchEvent) => {
      if (el.scrollHeight <= el.clientHeight) {
        e.preventDefault();
      }
    };
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => el.removeEventListener('touchmove', onTouchMove);
  }, []);

  const isOwner = user?.email === OWNER_EMAIL;
  const navItems = baseNavItems.filter(item => !HIDDEN_TABS.includes(item.id) && (isOwner || !OWNER_ONLY_TABS.includes(item.id)));

  const BOTTOM_TAB_IDS: NavTab[] = ['upgrade', 'settings'];
  const topNavItems = navItems.filter(item => !BOTTOM_TAB_IDS.includes(item.id));
  const bottomNavItems = navItems.filter(item => BOTTOM_TAB_IDS.includes(item.id));

  const renderNavButton = (item: NavItem) => (
    <button
      key={item.id}
      onClick={() => {
        onTabChange(item.id);
        // Also announced on the shared channel, so a tab that holds its own
        // inner state can return to its top level. Clicking Projects while
        // inside a project used to do nothing at all: the tab was already
        // active, so nothing re-rendered and the detail view stayed put.
        window.dispatchEvent(new CustomEvent('chumoku:navigate', { detail: item.id }));
        setMobileOpen(false);
      }}
      title={item.label}
      className={`relative w-full flex items-center py-2 rounded-md text-[13px] font-medium transition-colors ${collapsed ? 'lg:justify-center lg:px-0 gap-3 px-3' : 'gap-3 px-3'} ${
        item.highlight
          ? ''
          : activeTab === item.id
            ? 'text-white'
            : 'text-white/45 hover:text-white/80'
      }`}
      style={{
        // `highlight` was declared on the nav item and then never read. It marks
        // the one link that is asking for money, and it now carries the only
        // other colour in the product.
        ...(item.highlight ? { color: 'var(--upgrade)' } : {}),
        ...(activeTab === item.id ? { background: 'var(--bg-raised)' } : {}),
      }}
    >
            {item.icon}
      <span className={`flex-1 text-left whitespace-nowrap ${collapsed ? 'lg:hidden' : ''}`}>{item.label}</span>
      {item.badge && (
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0 ${collapsed ? 'lg:hidden' : ''}`} style={{ background: 'rgba(var(--accent-rgb),0.12)', color: 'var(--accent)' }}>
          {item.badge}
        </span>
      )}
    </button>
  );

  return (
    <div className="flex overflow-hidden relative" style={{ background: 'var(--bg-app)', maxWidth: '100vw', height: '100dvh' }}>

      {/* Collapsing narrows the sidebar to an icon rail rather than hiding it, so
          every tab stays one click away. On phones this is always the full-width
          drawer — `collapsed` is a desktop-only idea. */}
      {/* overflow-hidden matters for the collapse animation: labels are clipped
          by the narrowing panel instead of re-wrapping inside it. */}
      <aside className={`
        fixed inset-y-0 left-0 z-50 flex flex-col w-56 border-r overflow-hidden
        transition-[width,transform] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]
        ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0
        ${collapsed ? 'lg:w-14' : 'lg:w-56'}
      `} style={{ background: 'var(--bg-app)', borderColor: 'var(--line)' }}>
        {/* Brand row: single full-width button to Home, never signs the user out.
            The collapse toggle lives outside the sidebar (see below), Higgsfield-style. */}
        <div className="px-3 py-3.5 flex-shrink-0" style={{ borderBottom: '1px solid var(--line)' }}>
          <button
            onClick={() => { onTabChange('home'); setMobileOpen(false); }}
            title="Chumoku"
            className={`w-full flex items-center py-1 rounded-lg font-semibold tracking-tight text-[15px] transition-colors group ${collapsed ? 'lg:justify-center lg:px-0 gap-3 px-3' : 'gap-3 px-3'}`}
          >
            <HubIcon
              className={`w-4 h-4 flex-shrink-0 transition-colors ${activeTab === 'home' ? 'text-[var(--accent)]' : 'text-white group-hover:text-[var(--accent)]'}`}
            />
            {/* Icon and wordmark are one button, so hovering either turns both
                the same blue. The uppercase wordmark sits on a taller line box
                than the icon, which is what made the two look a pixel out of
                line; leading-none drops that extra space. */}
            <span className={`leading-none whitespace-nowrap uppercase tracking-[0.12em] text-[13px] transition-colors ${activeTab === 'home' ? 'text-[var(--accent)]' : 'text-white group-hover:text-[var(--accent)]'} ${collapsed ? 'lg:hidden' : ''}`}>
              Chumoku
            </span>
          </button>
        </div>

        <nav className="flex-1 flex flex-col px-3 py-4 overflow-y-auto">
          <div className="space-y-0.5">
            {topNavItems.map(item => renderNavButton(item))}
          </div>
          {/* Upgrade/Partners/Settings sit apart from the main tools, pinned
              toward the bottom of the sidebar (just above Sign Out) instead
              of inline in the tool list. */}
          <div className="mt-auto pt-4 space-y-0.5" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            {bottomNavItems.map(item => renderNavButton(item))}
          </div>
        </nav>

        <div className="px-3 py-4 flex-shrink-0 space-y-1" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <div className={`px-3 py-2 ${collapsed ? 'lg:hidden' : ''}`}>
            <p className="text-xs text-gray-600 truncate">{user?.email}</p>
          </div>
          <button
            onClick={() => signOut()}
            title={collapsed ? `Sign out (${user?.email ?? ''})` : 'Sign Out'}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-400 hover:text-white hover:bg-white/5 transition-all"
          >
            <LogOut className="w-4 h-4 flex-shrink-0" />
            <span className={`whitespace-nowrap ${collapsed ? 'lg:hidden' : ''}`}>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Always mounted so it can fade out as the drawer slides away, rather
          than vanishing the instant the drawer starts to close. */}
      <div
        className={`fixed inset-0 z-40 bg-black/60 lg:hidden transition-opacity duration-300 ${mobileOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={() => setMobileOpen(false)}
        aria-hidden="true"
      />

      {/* Collapse toggle: lives outside the sidebar, like Higgsfield's — hangs
          just past the sidebar's edge when open, and at the far left when closed. */}
      <button
        onClick={() => setCollapsed(c => !c)}
        title={collapsed ? 'Show sidebar' : 'Collapse sidebar'}
        aria-label={collapsed ? 'Show sidebar' : 'Collapse sidebar'}
        className={`hidden lg:flex fixed top-4 z-40 p-2 rounded-lg text-gray-500 hover:text-white transition-[left,color] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] ${collapsed ? 'left-[4.5rem]' : 'left-[15rem]'}`}
        style={{ background: 'rgba(var(--surface-rgb),0.8)', border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}
      >
        {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
      </button>

      {/* The rail, the page and the toggle all move on the same curve and the
          same 300ms. They used to run transition-all at 200ms, which animated
          colours and borders alongside the width and left the three of them
          arriving at slightly different moments - that mismatch is what read
          as jerky rather than the speed. */}
      <div className={`flex-1 flex flex-col min-w-0 relative overflow-x-hidden transition-[margin-left] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] ${collapsed ? 'lg:ml-14' : 'lg:ml-56'}`} style={{ zIndex: 1 }}>
        {/* Analyze used to sit on the ruled grid. Taken off 2026-09-23: with
            the chat full of answers it was texture behind text, and the side
            panel never had it, so the same chat looked like two products. The
            grid lives on the landing hero only now. */}

        {/* The grid is Analyze's alone. It is the one tab that is mostly open
            space — a headline, a composer, and a lot of nothing until the
            first answer arrives — and that emptiness needs a texture to read
            as deliberate. Every other tab is a page of work and looks better
            on flat ground.

            relative + z-index keeps the page above it, so the chat's sheet can
            cover the lines under the conversation. Without that the grid, being
            the only positioned layer, painted over the text. */}
        <main ref={mainRef} key={activeTab} className="relative z-[1] flex-1 overflow-y-auto overflow-x-hidden animate-tab-in pb-24 lg:pb-0" style={{ background: 'transparent', overscrollBehavior: 'none' }}>
          <MobileHeaderContext.Provider value={{ setRightAction }}>
            {children}
          </MobileHeaderContext.Provider>
        </main>

        {/* On a phone, the app's tab bar instead of a top bar with a menu
            (2026-10-30, Ivan: the site should look like the app). Four tabs,
            a floating glass capsule, the page's own big title above. The
            sidebar and its menu stay for wide screens. */}
        <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 flex justify-center px-4 pointer-events-none"
             style={{ paddingBottom: 'max(10px, env(safe-area-inset-bottom))' }}>
          <div className="pointer-events-auto flex items-center gap-0.5 p-1 rounded-full w-full max-w-[360px]"
               style={{ background: 'rgba(28,28,30,0.72)', border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(24px) saturate(1.6)', WebkitBackdropFilter: 'blur(24px) saturate(1.6)', boxShadow: '0 10px 30px rgba(0,0,0,0.45)' }}>
            {MOBILE_TABS.map(t => {
              const on = activeTab === t.id;
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  onClick={() => { onTabChange(t.id); window.dispatchEvent(new CustomEvent('chumoku:navigate', { detail: t.id })); }}
                  className="flex-1 flex flex-col items-center py-1.5 rounded-full transition-colors"
                  style={{ background: on ? 'rgba(255,255,255,0.1)' : 'transparent', color: on ? 'var(--text)' : 'var(--text-muted)' }}
                  aria-current={on ? 'page' : undefined}
                >
                  <Icon className="w-5 h-5" />
                  <span className="text-[10px] font-medium leading-3 mt-0.5">{t.label}</span>
                </button>
              );
            })}
          </div>
        </nav>
      </div>
    </div>
  );
}
