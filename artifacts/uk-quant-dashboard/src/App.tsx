import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  BarChart3,
  CalendarClock,
  Check,
  ChevronRight,
  CircleAlert,
  CircleDollarSign,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  LogOut,
  Menu,
  Minus,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
import {
  getGetAssetsQueryKey,
  getGetCurrentUserQueryKey,
  getGetDashboardQueryKey,
  getGetCustomTradingCostsQueryKey,
  getGetSignalsQueryKey,
  getGetTradingModeQueryKey,
  getHealthCheckQueryKey,
  useDepositCash,
  useCompareCustomTradingCosts,
  useGetAssets,
  useGetCurrentUser,
  useGetDashboard,
  useGetCustomTradingCosts,
  useGetSignals,
  useGetTradingMode,
  useHealthCheck,
  useLogin,
  useLogout,
  useRegister,
  useSetTradingMode,
  useUpdateRiskSettings,
  useWithdrawCash,
} from '@workspace/api-client-react';
import type { Asset, BacktestSummary, CustomCostScenarioResult, Position, PriceRevisionAuditEntry, RiskSettings, Signal, TradingModeBlocker, User } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { hasPriceRevisionAudit, parseRevisionAuditDate } from '@/lib/price-revision-audit';
import { executionCostThresholdHeadroom, executionCostThresholdValue } from '@/lib/execution-cost-threshold';
import { formatScheduledSession, nearestPendingExecutionDelay } from '@/lib/signal-schedule';
import { runTradingModeBlockerAction } from '@/lib/trading-mode-blockers';
import { liveReadinessAlert } from '@/lib/live-readiness-alert';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import './index.css';

const queryClient = new QueryClient();

type AuthMode = 'login' | 'register';
type CashMode = 'deposit' | 'withdraw';
type View = 'overview' | 'signals' | 'watchlist';

const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const shortDate = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

function formatMoney(value: number | undefined) {
  return gbp.format(Number(value ?? 0));
}

function formatPct(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function signalOrderLabel(signal: Signal) {
  if (signal.orderType === 'STOP_LOSS') return 'STOP-LOSS SELL';
  return signal.action;
}

function SignalStatus({ signal, compact = false }: { signal: Signal; compact?: boolean }) {
  const pending = signal.status === 'PENDING';
  const scheduled = signal.scheduledExecutionAt
    ? formatScheduledSession(signal.scheduledExecutionAt)
    : null;
  return (
    <div data-testid={`status-signal-${signal.id}`} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: compact ? 5 : 0 }}>
      <span className={`tag ${pending ? 'tag-hold' : 'tag-buy'}`}>
        {pending ? <CalendarClock size={10} /> : <Check size={10} />}
        {pending ? 'Pending' : 'Completed'}
      </span>
      <span className="muted mono" style={{ fontSize: 9, whiteSpace: 'nowrap' }}>
        {pending ? (scheduled ? `Eligible next session: ${scheduled}` : 'Awaiting session') : (scheduled ? `Completed after ${scheduled} session` : 'Executed')}
      </span>
    </div>
  );
}

function AppRouter() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function Home() {
  const currentUser = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey(), retry: false },
  });
  const health = useHealthCheck({
    query: { queryKey: getHealthCheckQueryKey(), staleTime: 60_000, retry: 1 },
  });
  const queryClient = useQueryClient();

  if (currentUser.isLoading) return <LoadingScreen />;

  if (!currentUser.data) {
    return <AuthScreen healthStatus={health.data?.status} />;
  }

  return (
    <DashboardWorkspace
      user={currentUser.data}
      healthStatus={health.data?.status}
      onLogout={() => {
        queryClient.removeQueries({ queryKey: getGetDashboardQueryKey() });
         queryClient.removeQueries({ queryKey: getGetCustomTradingCostsQueryKey() });
        queryClient.removeQueries({ queryKey: getGetAssetsQueryKey() });
        queryClient.removeQueries({ queryKey: getGetSignalsQueryKey() });
      }}
    />
  );
}

function LoadingScreen() {
  return (
    <div className="auth-backdrop">
      <div className="auth-grid" />
      <div className="auth-card" style={{ opacity: 1 }}>
        <div className="skeleton" style={{ width: 36, height: 36, borderRadius: 10 }} />
        <div className="skeleton" style={{ width: '58%', height: 24, marginTop: 26, borderRadius: 5 }} />
        <div className="skeleton" style={{ width: '82%', height: 12, marginTop: 12, borderRadius: 4 }} />
        <div className="skeleton" style={{ width: '100%', height: 46, marginTop: 30, borderRadius: 9 }} />
        <div className="skeleton" style={{ width: '100%', height: 46, marginTop: 12, borderRadius: 9 }} />
      </div>
    </div>
  );
}

function AuthScreen({ healthStatus }: { healthStatus?: string }) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState('');
  const queryClient = useQueryClient();
  const login = useLogin();
  const register = useRegister();
  const pending = login.isPending || register.isPending;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError('');
    if (!email.trim() || !email.includes('@')) {
      setFormError('Enter a valid email address.');
      return;
    }
    if (password.length < 8) {
      setFormError('Password must be at least 8 characters.');
      return;
    }
    const mutation = mode === 'login' ? login : register;
    mutation.mutate(
      { data: { email: email.trim(), password } },
      {
        onSuccess: (response) => {
          queryClient.setQueryData(getGetCurrentUserQueryKey(), response.user);
        },
        onError: () => setFormError(mode === 'login' ? 'Email or password not recognised.' : 'Could not create this account. Try again.'),
      },
    );
  };

  return (
    <div className="auth-backdrop">
      <div className="auth-grid" />
      <div className="auth-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div className="brand-mark"><Activity size={19} strokeWidth={2.5} /></div>
          <div className="eyebrow" style={{ paddingTop: 9 }}>UK / PAPER MODE</div>
        </div>
        <div style={{ marginTop: 25 }}>
          <h1 style={{ fontSize: 28, letterSpacing: '-.05em', lineHeight: 1.1, margin: 0, fontWeight: 800 }}>
            Signal, not noise.
          </h1>
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.65, margin: '12px 0 0', maxWidth: 330 }}>
            A private workspace for systematic GBP trend decisions. No real money moves here.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 3, padding: 4, borderRadius: 10, background: 'hsl(var(--secondary))', marginTop: 28 }}>
          {(['login', 'register'] as AuthMode[]).map((item) => (
            <button
              key={item}
              data-testid={`button-auth-${item}`}
              type="button"
              onClick={() => { setMode(item); setFormError(''); }}
              className="button"
              style={{ flex: 1, padding: '9px 8px', background: mode === item ? 'hsl(var(--card))' : 'transparent', color: mode === item ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))', borderColor: mode === item ? 'hsl(var(--border))' : 'transparent' }}
            >
              {item === 'login' ? 'Sign in' : 'Create account'}
            </button>
          ))}
        </div>
        <form onSubmit={submit} style={{ marginTop: 22 }}>
          <label className="eyebrow" htmlFor="auth-email">Email address</label>
          <input id="auth-email" data-testid="input-auth-email" className="field" style={{ marginTop: 8 }} type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.co.uk" />
          <label className="eyebrow" htmlFor="auth-password" style={{ display: 'block', marginTop: 18 }}>Password</label>
          <div style={{ position: 'relative', marginTop: 8 }}>
            <input id="auth-password" data-testid="input-auth-password" className="field" style={{ paddingRight: 43 }} type={showPassword ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="8 characters minimum" />
            <button data-testid="button-toggle-password" type="button" className="button button-plain" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} style={{ position: 'absolute', right: 5, top: 5 }}>
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {formError && <div data-testid="status-auth-error" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', color: 'hsl(var(--destructive))', fontSize: 12, lineHeight: 1.45, marginTop: 14 }}><CircleAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} />{formError}</div>}
          <button data-testid="button-submit-auth" className="button button-primary" type="submit" disabled={pending} style={{ width: '100%', marginTop: 22, minHeight: 44 }}>
            {pending ? <RefreshCw size={15} className="animate-spin" /> : <ArrowUpRight size={15} />}
            {pending ? 'Checking workspace…' : mode === 'login' ? 'Enter workspace' : 'Create workspace'}
          </button>
        </form>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 23, color: 'hsl(var(--muted-foreground))', fontSize: 11 }}>
          <ShieldCheck size={14} className="text-teal" />
          <span>Paper trading only · {healthStatus === 'ok' ? 'systems online' : 'protected session'}</span>
        </div>
      </div>
    </div>
  );
}

function DashboardWorkspace({ user, healthStatus, onLogout }: { user: User; healthStatus?: string; onLogout: () => void }) {
  const [view, setView] = useState<View>('overview');
  const [mobileNav, setMobileNav] = useState(false);
  const [cashMode, setCashMode] = useState<CashMode | null>(null);
  const [brokerOpen, setBrokerOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [riskOpen, setRiskOpen] = useState(false);
  const [modeError, setModeError] = useState('');
  const [toast, setToast] = useState('');
  const previousLiveTradingAvailable = useRef<boolean | undefined>(undefined);
  const queryClient = useQueryClient();
  const logout = useLogout();
  const dashboard = useGetDashboard({ query: { queryKey: getGetDashboardQueryKey(), retry: 1 } });
  const assetsQuery = useGetAssets({ query: { queryKey: getGetAssetsQueryKey(), retry: 1 } });
  const signalsQuery = useGetSignals({ query: { queryKey: getGetSignalsQueryKey(), retry: 1 } });
  const tradingModeQuery = useGetTradingMode({ query: { queryKey: getGetTradingModeQueryKey(), retry: 1, refetchInterval: 60_000 } });
  const deposit = useDepositCash();
  const withdraw = useWithdrawCash();
  const setTradingMode = useSetTradingMode();
  const updateRiskSettings = useUpdateRiskSettings();

  const assets = useMemo<Asset[]>(() => dashboard.data?.assets ?? assetsQuery.data ?? [], [dashboard.data?.assets, assetsQuery.data]);
  const signals = useMemo<Signal[]>(() => dashboard.data?.signals ?? signalsQuery.data ?? [], [dashboard.data?.signals, signalsQuery.data]);
  const loading = dashboard.isLoading && assets.length === 0;
  const error = dashboard.isError && assets.length === 0;

  useEffect(() => {
    const delay = nearestPendingExecutionDelay(signals);
    if (delay === null) return undefined;

    const timeout = window.setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    }, delay);
    return () => window.clearTimeout(timeout);
  }, [queryClient, signals]);

  const flash = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 3600);
  };

  useEffect(() => {
    const liveTradingAvailable = tradingModeQuery.data?.liveTradingAvailable;
    if (typeof liveTradingAvailable !== 'boolean') return undefined;

    const alert = liveReadinessAlert(
      previousLiveTradingAvailable.current,
      liveTradingAvailable,
    );
    if (alert) {
      setToast(alert);
      const timeout = window.setTimeout(() => setToast(''), 5000);
      previousLiveTradingAvailable.current = liveTradingAvailable;
      return () => window.clearTimeout(timeout);
    }

    previousLiveTradingAvailable.current = liveTradingAvailable;
    return undefined;
  }, [tradingModeQuery.data?.liveTradingAvailable]);

  const performLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        queryClient.setQueryData(getGetCurrentUserQueryKey(), undefined);
        onLogout();
      },
      onError: () => flash('Could not end the session. Try again.'),
    });
  };

  if (loading) return <DashboardSkeleton user={user} />;
  if (error) return <DashboardError onRetry={() => dashboard.refetch()} />;

  const cash = dashboard.data?.cash ?? 0;
  const invested = dashboard.data?.invested ?? 0;
  const totalValue = dashboard.data?.totalValue ?? cash + invested;
  const dailyPnl = dashboard.data?.dailyPnl ?? 0;
  const positions = dashboard.data?.positions ?? [];
  const tradingMode = tradingModeQuery.data?.mode ?? 'PAPER';
  const liveTradingAvailable = tradingModeQuery.data?.liveTradingAvailable ?? false;
  const brokerReady = tradingModeQuery.data?.brokerReady ?? false;
  const historicalPolicyReady = tradingModeQuery.data?.historicalPolicyReady ?? false;
  const liveTradingBlockers = tradingModeQuery.data?.blockers ?? [];

  const changeTradingMode = (mode: 'PAPER' | 'LIVE') => {
    setModeError('');
    setTradingMode.mutate(
      { data: { mode } },
      {
        onSuccess: () => {
          setModeOpen(false);
          queryClient.invalidateQueries({ queryKey: getGetTradingModeQueryKey() });
          flash(mode === 'LIVE' ? 'Live trading mode enabled.' : 'Paper mode enabled.');
        },
        onError: () => {
          setModeError(liveTradingBlockers.length ? `Live trading is locked: ${liveTradingBlockers.map((blocker) => blocker.message).join(' ')}` : 'Live trading is currently locked by the server safety policy.');
        },
      },
    );
  };

  return (
    <div className="app-shell">
      <div style={{ display: 'flex', minHeight: '100dvh' }}>
        <aside style={{ width: 236, flexShrink: 0, background: 'hsl(var(--sidebar) / .86)', borderRight: '1px solid hsl(var(--sidebar-border))', padding: '22px 14px', display: 'flex', flexDirection: 'column' }} className={mobileNav ? '' : 'desktop-only'}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px 28px' }}>
            <div className="brand-mark" style={{ width: 30, height: 30 }}><Activity size={16} /></div>
            <div><div style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-.02em' }}>Northstar</div><div className="eyebrow" style={{ fontSize: 8, marginTop: 3 }}>GBP trend lab</div></div>
          </div>
          <div className="eyebrow" style={{ padding: '0 10px 10px' }}>Workspace</div>
          <nav style={{ display: 'grid', gap: 3 }}>
            <SideNavButton active={view === 'overview'} icon={<BarChart3 size={16} />} label="Overview" onClick={() => { setView('overview'); setMobileNav(false); }} testId="nav-overview" />
            <SideNavButton active={view === 'signals'} icon={<Sparkles size={16} />} label="Signal log" onClick={() => { setView('signals'); setMobileNav(false); }} testId="nav-signals" />
            <SideNavButton active={view === 'watchlist'} icon={<Eye size={16} />} label="Watchlist" onClick={() => { setView('watchlist'); setMobileNav(false); }} testId="nav-watchlist" />
          </nav>
          <div style={{ marginTop: 'auto' }}>
            <div style={{ border: '1px solid hsl(var(--border))', borderRadius: 10, padding: 12, background: 'hsl(var(--card) / .55)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: 'hsl(var(--primary))', boxShadow: '0 0 0 4px hsl(var(--primary) / .1)' }} /><span className="eyebrow" style={{ color: 'hsl(var(--primary))', fontSize: 9 }}>{healthStatus === 'ok' ? 'History loaded' : 'Data protected'}</span></div>
              <p className="muted" style={{ margin: '10px 0 0', fontSize: 11, lineHeight: 1.55 }}>Signals use imported adjusted UK daily closes.</p>
            </div>
            <button data-testid="button-sidebar-logout" className="button button-plain" onClick={performLogout} disabled={logout.isPending} style={{ width: '100%', justifyContent: 'flex-start', marginTop: 12, padding: '10px' }}><LogOut size={15} />{logout.isPending ? 'Ending session…' : 'Sign out'}</button>
          </div>
        </aside>
        <main style={{ minWidth: 0, flex: 1 }}>
          <header style={{ height: 70, borderBottom: '1px solid hsl(var(--border))', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 clamp(16px, 3vw, 36px)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button data-testid="button-mobile-nav" className="button button-plain mobile-nav-trigger" onClick={() => setMobileNav((value) => !value)}><Menu size={18} /></button>
              <div><div className="eyebrow">{shortDate.format(new Date())}</div><div style={{ fontSize: 16, fontWeight: 800, marginTop: 4 }}>Good to see you, {user.email.split('@')[0]}</div></div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button data-testid="button-trading-mode" className="mode-pill" onClick={() => { setModeError(''); setModeOpen(true); }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: tradingMode === 'LIVE' ? 'hsl(var(--destructive))' : 'hsl(var(--primary))', boxShadow: `0 0 0 3px ${tradingMode === 'LIVE' ? 'hsl(var(--destructive) / .14)' : 'hsl(var(--primary) / .14)'}` }} />
                {tradingMode === 'LIVE' ? 'Live mode' : 'Paper mode'}
                <ChevronRight size={12} />
              </button>
              <div style={{ width: 32, height: 32, display: 'grid', placeItems: 'center', borderRadius: '50%', background: 'hsl(var(--primary) / .12)', color: 'hsl(var(--primary))', fontSize: 11, fontWeight: 800 }}>{user.email.slice(0, 2).toUpperCase()}</div>
            </div>
          </header>
          <div style={{ maxWidth: 1500, margin: '0 auto', padding: 'clamp(20px, 3vw, 38px)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 18, marginBottom: 27 }}>
              <div><div className="eyebrow">Portfolio command centre</div><h1 style={{ fontSize: 'clamp(24px, 3vw, 34px)', letterSpacing: '-.055em', margin: '8px 0 0', fontWeight: 800 }}>{view === 'overview' ? 'Stay with the trend.' : view === 'signals' ? 'Every signal, explained.' : 'The UK watchlist.'}</h1></div>
              <button data-testid="button-broker-connect" className="button button-quiet" onClick={() => setBrokerOpen(true)}><KeyRound size={15} />Connect broker <ChevronRight size={14} /></button>
            </div>
             {view === 'overview' && <Overview assets={assets} signals={signals} positions={positions} cash={cash} invested={invested} totalValue={totalValue} dailyPnl={dailyPnl} riskSettings={dashboard.data?.riskSettings} backtest={dashboard.data?.backtest} priceRevisionAudit={dashboard.data?.priceRevisionAudit ?? []} onCash={setCashMode} onSignals={() => setView('signals')} onEditRisk={() => setRiskOpen(true)} />}
            {view === 'signals' && <SignalLog signals={signals} />}
            {view === 'watchlist' && <Watchlist assets={assets} />}
            <footer style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginTop: 34, paddingTop: 18, borderTop: '1px solid hsl(var(--border))', color: 'hsl(var(--muted-foreground))', fontSize: 10 }}>
              <span className="mono">NORTHSTAR / {tradingMode === 'LIVE' ? 'LIVE TRADING' : 'PAPER TRADING'} / GBP</span><span>{tradingMode === 'LIVE' ? 'Broker execution enabled' : 'Historical adjusted data · no investment advice'}</span>
            </footer>
          </div>
        </main>
      </div>
      {mobileNav && <button data-testid="button-close-mobile-nav" aria-label="Close navigation" onClick={() => setMobileNav(false)} style={{ position: 'fixed', inset: 0, zIndex: 15, background: 'transparent', border: 0 }} />}
      {cashMode && <CashModal mode={cashMode} cash={cash} mutation={cashMode === 'deposit' ? deposit : withdraw} onClose={() => setCashMode(null)} onSuccess={(message) => { setCashMode(null); flash(message); queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); }} />}
      {brokerOpen && <BrokerModal onClose={() => setBrokerOpen(false)} />}
       {modeOpen && <TradingModeModal currentMode={tradingMode} brokerReady={brokerReady} historicalPolicyReady={historicalPolicyReady} blockers={liveTradingBlockers} liveTradingAvailable={liveTradingAvailable} error={modeError} pending={setTradingMode.isPending} onClose={() => setModeOpen(false)} onBlockerAction={(action) => {
         setModeOpen(false);
         runTradingModeBlockerAction(action, {
           openBrokerSetup: () => setBrokerOpen(true),
           openRiskSettings: () => setRiskOpen(true),
           showBacktestDetails: () => {
             setView('overview');
             window.setTimeout(() => document.querySelector('[data-testid="panel-strategy-safety"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
           },
         });
       }} onSelectMode={changeTradingMode} />}
      {riskOpen && dashboard.data?.riskSettings && <RiskSettingsModal settings={dashboard.data.riskSettings} pending={updateRiskSettings.isPending} onClose={() => setRiskOpen(false)} onSave={(settings) => updateRiskSettings.mutate({ data: settings }, { onSuccess: (result) => { queryClient.setQueryData(getGetDashboardQueryKey(), result); setRiskOpen(false); flash('Risk limits saved. Backtest rerun in paper mode.'); } })} />}
      {toast && <div data-testid="status-toast" className="toast"><div style={{ display: 'flex', gap: 9, alignItems: 'center', fontSize: 12 }}><Check size={15} className="text-teal" />{toast}</div></div>}
    </div>
  );
}

function TradingModeModal({ currentMode, brokerReady, historicalPolicyReady, blockers, liveTradingAvailable, error, pending, onClose, onBlockerAction, onSelectMode }: { currentMode: 'PAPER' | 'LIVE'; brokerReady: boolean; historicalPolicyReady: boolean; blockers: TradingModeBlocker[]; liveTradingAvailable: boolean; error: string; pending: boolean; onClose: () => void; onBlockerAction: (action: TradingModeBlocker['action']) => void; onSelectMode: (mode: 'PAPER' | 'LIVE') => void }) {
  const isPaper = currentMode === 'PAPER';
  return <div className="modal-backdrop"><div className="modal" data-testid="modal-trading-mode">
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
      <div><div className="eyebrow" style={{ color: isPaper ? 'hsl(var(--primary))' : 'hsl(var(--destructive))' }}>Trading mode</div><h2 style={{ fontSize: 20, letterSpacing: '-.04em', margin: '7px 0 0' }}>{isPaper ? 'Ready when you are.' : 'Live execution is on.'}</h2></div>
      <button data-testid="button-close-trading-mode" className="button button-plain" onClick={onClose}><X size={17} /></button>
    </div>
    <p className="muted" style={{ fontSize: 12, lineHeight: 1.65, margin: '14px 0 0' }}>{isPaper ? 'The server checks broker readiness and every historical safety policy before it can enable live mode.' : 'Real orders can be sent to your connected broker. Switch back to paper mode before changing strategy settings.'}</p>
    <div className="mode-status-list">
      <div><span>Current mode</span><strong className={isPaper ? 'text-teal' : 'text-red'}>{isPaper ? 'Paper trading' : 'Live trading'}</strong></div>
      <div><span>Broker connection</span><strong className={brokerReady ? 'text-teal' : 'text-amber'}>{brokerReady ? 'Verified' : 'Not ready'}</strong></div>
      <div><span>Historical policy</span><strong className={historicalPolicyReady ? 'text-teal' : 'text-amber'}>{historicalPolicyReady ? 'Passed' : 'Checks failed'}</strong></div>
      <div><span>Live order routing</span><strong className={liveTradingAvailable ? 'text-teal' : 'text-amber'}>{liveTradingAvailable ? 'Available' : 'Locked'}</strong></div>
    </div>
    {!liveTradingAvailable && blockers.length > 0 && <div style={{ marginTop: 16 }} data-testid="list-trading-mode-blockers">
      <div className="eyebrow">What still needs attention</div>
      <div style={{ display: 'grid', gap: 8, marginTop: 9 }}>
        {blockers.map((blocker) => <div key={blocker.code} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11, lineHeight: 1.55 }}>
          <CircleAlert size={14} className="text-amber" style={{ flexShrink: 0, marginTop: 5 }} />
          <div style={{ flex: 1 }}>
            <span>{blocker.message}</span>
            <button data-testid={`button-blocker-action-${blocker.code.toLowerCase()}`} className="button button-plain" onClick={() => onBlockerAction(blocker.action)} style={{ padding: '5px 0 0', minHeight: 0, fontSize: 10 }}>
              {blocker.action === 'BROKER_SETUP' ? 'Open broker setup' : blocker.action === 'RISK_SETTINGS' ? 'Tune risk limits' : 'Review backtest details'} <ChevronRight size={12} />
            </button>
          </div>
        </div>)}
      </div>
    </div>}
    {error && <div data-testid="status-trading-mode-error" className="modal-error"><CircleAlert size={15} />{error}</div>}
    <div style={{ display: 'flex', gap: 9, marginTop: 22 }}>
      <button data-testid="button-stay-paper" className="button button-quiet" onClick={() => onSelectMode('PAPER')} disabled={pending} style={{ flex: 1 }}>{pending && !isPaper ? <RefreshCw size={14} className="animate-spin" /> : <ShieldCheck size={14} />}Stay in paper</button>
      <button data-testid="button-go-live" className="button button-primary" onClick={() => onSelectMode('LIVE')} disabled={!liveTradingAvailable || pending} style={{ flex: 1, opacity: liveTradingAvailable ? 1 : .55 }}>{pending && isPaper ? <RefreshCw size={14} className="animate-spin" /> : <ArrowUpRight size={14} />} {liveTradingAvailable ? 'Go live' : 'Go live (locked)'}</button>
    </div>
    <div className="muted" style={{ fontSize: 10, lineHeight: 1.5, marginTop: 13 }}>Live mode is a safety-gated setting. It never places an order just by opening this panel.</div>
  </div></div>;
}

function SideNavButton({ active, icon, label, onClick, testId }: { active: boolean; icon: ReactNode; label: string; onClick: () => void; testId: string }) {
  return <button data-testid={testId} type="button" onClick={onClick} className="button" style={{ width: '100%', justifyContent: 'flex-start', padding: '10px', color: active ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))', background: active ? 'hsl(var(--sidebar-accent))' : 'transparent', borderColor: active ? 'hsl(var(--border))' : 'transparent' }}>{icon}<span style={{ flex: 1, textAlign: 'left' }}>{label}</span>{active && <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'hsl(var(--primary))' }} />}</button>;
}

function Overview({ assets, signals, positions, cash, invested, totalValue, dailyPnl, riskSettings, backtest, priceRevisionAudit, onCash, onSignals, onEditRisk }: { assets: Asset[]; signals: Signal[]; positions: Position[]; cash: number; invested: number; totalValue: number; dailyPnl: number; riskSettings?: RiskSettings; backtest?: BacktestSummary; priceRevisionAudit: PriceRevisionAuditEntry[]; onCash: (mode: CashMode) => void; onSignals: () => void; onEditRisk: () => void }) {
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section className="overview-metrics" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
        <MetricCard label="Total value" value={formatMoney(totalValue)} sub="Paper portfolio" icon={<CircleDollarSign size={17} />} />
        <MetricCard label="Available cash" value={formatMoney(cash)} sub="Ready to allocate" icon={<Database size={17} />} action={<div style={{ display: 'flex', gap: 6, marginTop: 14 }}><button data-testid="button-deposit-cash" className="button button-quiet" onClick={() => onCash('deposit')} style={{ padding: '7px 9px', fontSize: 10 }}><Plus size={12} />Deposit</button><button data-testid="button-withdraw-cash" className="button button-plain" onClick={() => onCash('withdraw')} style={{ padding: '7px 7px', fontSize: 10 }}><ArrowDownLeft size={12} />Withdraw</button></div>} />
         <MetricCard label="Invested" value={formatMoney(invested)} sub={positions.length ? `${positions.length} holdings` : 'Waiting for a BUY signal'} icon={<BarChart3 size={17} />} />
        <MetricCard label="Today's P&L" value={`${dailyPnl >= 0 ? '+' : ''}${formatMoney(dailyPnl)}`} sub="Since previous close" icon={dailyPnl >= 0 ? <TrendingUp size={17} /> : <TrendingDown size={17} />} accent={dailyPnl >= 0 ? 'teal' : 'red'} />
      </section>
      <section className="overview-main" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.65fr) minmax(300px, .85fr)', gap: 16 }}>
        <MarketPanel assets={assets} />
        <SignalPanel signals={signals} onSignals={onSignals} />
      </section>
       <PositionsPanel positions={positions} />
       {riskSettings && backtest && <StrategyPanel settings={riskSettings} backtest={backtest} onEdit={onEditRisk} />}
       {hasPriceRevisionAudit(priceRevisionAudit) && <PriceRevisionAudit revisions={priceRevisionAudit} />}
      <section className="panel" style={{ padding: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18, borderColor: 'hsl(var(--primary) / .18)', background: 'linear-gradient(90deg, hsl(171 82% 53% / .06), hsl(var(--card)))' }}>
         <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}><div style={{ width: 38, height: 38, display: 'grid', placeItems: 'center', borderRadius: 10, background: 'hsl(var(--primary) / .1)', color: 'hsl(var(--primary))' }}><ShieldCheck size={19} /></div><div><div style={{ fontSize: 13, fontWeight: 800 }}>Automatic paper strategy is active</div><div className="muted" style={{ fontSize: 11, marginTop: 5 }}>BUY signals invest available cash equally. SELL signals close matching holdings to protect the portfolio. No real money moves.</div></div></div>
        <div className="eyebrow" style={{ color: 'hsl(var(--primary))', whiteSpace: 'nowrap' }}>No live orders</div>
      </section>
    </div>
  );
}

function PriceRevisionAudit({ revisions }: { revisions: PriceRevisionAuditEntry[] }) {
  return <section className="panel" data-testid="panel-price-revision-audit" style={{ overflow: 'hidden' }}>
    <div className="panel-header" style={{ padding: '18px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
      <div>
        <div className="eyebrow">Historical data audit</div>
        <h2 style={{ margin: '6px 0 0', fontSize: 15, letterSpacing: '-.02em' }}>Approved price revisions</h2>
        <p className="muted" style={{ margin: '7px 0 0', fontSize: 10, lineHeight: 1.55 }}>Read-only record for explaining changes to backtest and strategy results. Approvals happen separately during the controlled import workflow.</p>
      </div>
      <span className="tag tag-hold"><Eye size={11} />Read only</span>
    </div>
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 690 }}>
        <thead><tr style={{ textAlign: 'left' }}>{['Symbol', 'Market date', 'Old price', 'New price', 'Change', 'Approved'].map((heading) => <th key={heading} className="eyebrow" style={{ padding: '13px 20px', whiteSpace: 'nowrap' }}>{heading}</th>)}</tr></thead>
        <tbody>{revisions.map((revision, index) => <tr key={`${revision.symbol}-${revision.marketDate}-${revision.approvalDate}-${index}`} data-testid={`row-price-revision-${index}`} className="table-row" style={{ borderTop: '1px solid hsl(var(--border))' }}>
          <td style={{ padding: '14px 20px', fontSize: 12, fontWeight: 800 }}>{revision.symbol}</td>
          <td className="mono" style={{ padding: '14px 20px', fontSize: 11 }}>{shortDate.format(parseRevisionAuditDate(revision.marketDate))}</td>
          <td className="mono" style={{ padding: '14px 20px', fontSize: 11 }}>{formatMoney(revision.oldPrice)}</td>
          <td className="mono" style={{ padding: '14px 20px', fontSize: 11 }}>{formatMoney(revision.newPrice)}</td>
          <td className={revision.percentageChange >= 0 ? 'text-teal' : 'text-red'} style={{ padding: '14px 20px', fontFamily: 'var(--app-font-mono)', fontSize: 11 }}>{formatPct(revision.percentageChange)}</td>
          <td className="mono muted" style={{ padding: '14px 20px', fontSize: 11 }}>{shortDate.format(parseRevisionAuditDate(revision.approvalDate))}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

function StrategyPanel({ settings, backtest, onEdit }: { settings: RiskSettings; backtest: BacktestSummary; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const compareCosts = useCompareCustomTradingCosts();
  const savedCosts = useGetCustomTradingCosts({
    query: { queryKey: getGetCustomTradingCostsQueryKey(), retry: false },
  });
  const [customCosts, setCustomCosts] = useState<Record<'commissionPerOrder' | 'spreadBpsPerSide' | 'slippageBpsPerSide', number | string>>({ commissionPerOrder: 5, spreadBpsPerSide: 5, slippageBpsPerSide: 5 });
  const [customResult, setCustomResult] = useState<CustomCostScenarioResult | null>(null);
  const [customError, setCustomError] = useState('');
  const hydratedSavedCosts = useRef(false);
  useEffect(() => {
    if (!hydratedSavedCosts.current && savedCosts.isFetched) {
      hydratedSavedCosts.current = true;
      if (savedCosts.data) setCustomCosts(savedCosts.data);
    }
  }, [savedCosts.data, savedCosts.isFetched]);
  const customFields = [
    { key: 'commissionPerOrder' as const, label: 'Commission / order', suffix: 'GBP', step: 0.01 },
    { key: 'spreadBpsPerSide' as const, label: 'Half-spread / side', suffix: 'bps', step: 0.1 },
    { key: 'slippageBpsPerSide' as const, label: 'Slippage / side', suffix: 'bps', step: 0.1 },
  ];
  const customCostsValid = customFields.every(({ key }) => customCosts[key] !== '' && Number.isFinite(Number(customCosts[key])) && Number(customCosts[key]) >= 0 && Number(customCosts[key]) <= 100);
  const submitCustomCosts = (event: FormEvent) => {
    event.preventDefault();
    setCustomError('');
    setCustomResult(null);
    if (!customCostsValid) {
      setCustomError('Enter a value between 0 and 100 for each broker cost.');
      return;
    }
    const parsedCosts = {
      commissionPerOrder: Number(customCosts.commissionPerOrder),
      spreadBpsPerSide: Number(customCosts.spreadBpsPerSide),
      slippageBpsPerSide: Number(customCosts.slippageBpsPerSide),
    };
    compareCosts.mutate(
      { data: parsedCosts },
      {
        onSuccess: (result) => {
          setCustomResult(result);
          queryClient.setQueryData(getGetCustomTradingCostsQueryKey(), parsedCosts);
        },
        onError: () => setCustomError('Could not compare these costs. Check each value is between 0 and 100.'),
      },
    );
  };
  const metrics = [
    ['Gross return', formatPct(backtest.grossReturnPercent)],
    ['Net return', formatPct(backtest.netReturnPercent)],
    ['Trading costs', formatMoney(backtest.tradingCosts)],
    ['FTSE benchmark', formatPct(backtest.benchmarkReturnPercent)],
    ['Excess vs FTSE', formatPct(backtest.excessReturnPercent)],
    ['Max drawdown', `${backtest.maxDrawdownPercent.toFixed(2)}%`],
    ['Turnover', `${backtest.turnoverPercent.toFixed(1)}%`],
  ];
  return <section className="panel" data-testid="panel-strategy-safety" style={{ padding: 20 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
      <div><div className="eyebrow">Untouched holdout & risk gate</div><h2 style={{ margin: '7px 0 0', fontSize: 16 }}>{backtest.methodology.selectedStrategyName}</h2><p className="muted" style={{ margin: '8px 0 0', fontSize: 11 }}>{backtest.periodDays} adjusted-price sessions · {backtest.startDate} to {backtest.endDate} · selected only on {backtest.methodology.developmentStartDate} to {backtest.methodology.developmentEndDate}</p></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}><span className={`tag ${backtest.safetyPassed ? 'tag-buy' : 'tag-sell'}`}>{backtest.safetyPassed ? <Check size={11} /> : <CircleAlert size={11} />}{backtest.safetyPassed ? 'Safety checks passed' : 'Paper mode required'}</span><button data-testid="button-edit-risk" className="button button-quiet" onClick={onEdit}>Tune limits</button></div>
    </div>
    <div className="strategy-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 8, marginTop: 18 }}>
      {metrics.map(([label, value]) => <div key={label} style={{ padding: 12, borderRadius: 10, background: 'hsl(var(--secondary) / .6)' }}><div className="eyebrow" style={{ fontSize: 8 }}>{label}</div><div className="mono" style={{ fontSize: 15, marginTop: 8 }}>{value}</div></div>)}
    </div>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
      <span className="tag tag-hold">Position cap {settings.maxPositionPercent}%</span><span className="tag tag-hold">Stop-loss {settings.stopLossPercent}%</span><span className="tag tag-hold">Cash reserve {settings.cashReservePercent}%</span>
      {backtest.safetyChecks.map((check) => <span key={check.label} className={`tag ${check.passed ? 'tag-buy' : 'tag-sell'}`}>{check.passed ? <Check size={10} /> : <X size={10} />}{check.label}: {check.actual}{['Maximum drawdown', 'Net total return', 'Excess return vs FTSE'].includes(check.label) ? '%' : ''}</span>)}
    </div>
    <div data-testid="cost-scenario-comparison" style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div><div className="eyebrow">Execution-cost stress test</div><p className="muted" style={{ margin: '6px 0 0', fontSize: 10 }}>The selected strategy is fixed before these holdout scenarios are compared.</p></div>
        <span className="tag tag-hold">Base controls safety gate</span>
      </div>
      <div className="strategy-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, marginTop: 10 }}>
        {backtest.costScenarios.map((scenario) => {
          const isDefault = scenario.id === backtest.defaultSafetyScenario;
          return <div key={scenario.id} data-testid={`cost-scenario-${scenario.id.toLowerCase()}`} style={{ padding: 13, borderRadius: 10, border: `1px solid hsl(var(--${isDefault ? 'primary' : 'border'}) / ${isDefault ? '.35' : '1'})`, background: isDefault ? 'hsl(var(--primary) / .05)' : 'hsl(var(--secondary) / .35)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}><strong style={{ fontSize: 11 }}>{scenario.name}</strong><span className={`tag ${scenario.safetyPassed ? 'tag-buy' : 'tag-sell'}`}>{scenario.safetyPassed ? <Check size={10} /> : <X size={10} />}{scenario.safetyPassed ? 'Pass' : 'Fail'}{isDefault ? ' · gate' : ''}</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginTop: 12 }}>
              <div><div className="eyebrow" style={{ fontSize: 8 }}>Net holdout</div><div className="mono" style={{ marginTop: 5, fontSize: 13 }}>{formatPct(scenario.netReturnPercent)}</div></div>
              <div><div className="eyebrow" style={{ fontSize: 8 }}>Excess vs FTSE</div><div className="mono" style={{ marginTop: 5, fontSize: 13 }}>{formatPct(scenario.excessReturnPercent)}</div></div>
              <div><div className="eyebrow" style={{ fontSize: 8 }}>Trading costs</div><div className="mono" style={{ marginTop: 5, fontSize: 11 }}>{formatMoney(scenario.tradingCosts)}</div></div>
              <div><div className="eyebrow" style={{ fontSize: 8 }}>Max drawdown</div><div className="mono" style={{ marginTop: 5, fontSize: 11 }}>{scenario.maxDrawdownPercent.toFixed(2)}%</div></div>
            </div>
            <p className="muted" style={{ margin: '10px 0 0', fontSize: 9, lineHeight: 1.5 }}>{scenario.assumptions.description}</p>
          </div>;
        })}
      </div>
      <div data-testid="execution-cost-threshold" style={{ marginTop: 12, padding: 13, borderRadius: 10, border: '1px solid hsl(var(--primary) / .3)', background: 'hsl(var(--primary) / .06)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <div className="eyebrow">Safety break-even cost</div>
            <div className="mono" style={{ fontSize: 18, marginTop: 7 }}>
              {executionCostThresholdValue(backtest.executionCostThreshold)}
            </div>
          </div>
          <span className={`tag ${backtest.executionCostThreshold.headroomFromBaseMultiplier !== null && backtest.executionCostThreshold.headroomFromBaseMultiplier >= 0 ? 'tag-buy' : 'tag-sell'}`}>
            {executionCostThresholdHeadroom(backtest.executionCostThreshold)}
          </span>
        </div>
        {backtest.executionCostThreshold.thresholdAssumptions && <p className="muted" style={{ margin: '9px 0 0', fontSize: 10 }}>{backtest.executionCostThreshold.thresholdAssumptions.description}</p>}
        <p className="muted" style={{ margin: '7px 0 0', fontSize: 9, lineHeight: 1.5 }}>{backtest.executionCostThreshold.explanation} Search bounds: {backtest.executionCostThreshold.lowerBoundMultiplier}×–{backtest.executionCostThreshold.upperBoundMultiplier}× base; precision {backtest.executionCostThreshold.precisionMultiplier}×.</p>
      </div>
      <form data-testid="custom-cost-comparison" onSubmit={submitCustomCosts} style={{ marginTop: 12, padding: 13, borderRadius: 10, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card) / .65)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <div><strong style={{ fontSize: 11 }}>Your broker costs</strong><p className="muted" style={{ margin: '5px 0 0', fontSize: 9 }}>Comparison only — strategy selection and the base safety gate stay unchanged.</p></div>
          <span className="tag tag-hold">Not a safety gate</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(110px, 1fr)) auto', gap: 8, marginTop: 11, alignItems: 'end' }}>
          {customFields.map((field) => <label key={field.key}><span className="eyebrow" style={{ fontSize: 8 }}>{field.label} ({field.suffix})</span><input data-testid={`input-custom-${field.key}`} className="field mono" type="number" min="0" max="100" step={field.step} value={customCosts[field.key]} onChange={(event) => { setCustomCosts({ ...customCosts, [field.key]: event.target.value }); setCustomResult(null); setCustomError(''); }} style={{ marginTop: 6 }} /></label>)}
          <button data-testid="button-compare-custom-costs" className="button button-primary" type="submit" disabled={!customCostsValid || compareCosts.isPending}>{compareCosts.isPending ? <RefreshCw size={14} className="animate-spin" /> : <BarChart3 size={14} />}Compare</button>
        </div>
        {customError && <div className="text-red" style={{ fontSize: 10, marginTop: 9 }}>{customError}</div>}
        {customResult && <div data-testid="custom-cost-result" style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid hsl(var(--border))' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}><strong style={{ fontSize: 11 }}>Your broker · custom assumptions</strong><span className="tag tag-hold">Comparison only</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, marginTop: 10 }}>
            <div><div className="eyebrow" style={{ fontSize: 8 }}>Net holdout result</div><div className="mono" style={{ marginTop: 5, fontSize: 13 }}>{formatPct(customResult.netReturnPercent)}</div></div>
            <div><div className="eyebrow" style={{ fontSize: 8 }}>Excess vs FTSE</div><div className="mono" style={{ marginTop: 5, fontSize: 13 }}>{formatPct(customResult.excessReturnPercent)}</div></div>
            <div><div className="eyebrow" style={{ fontSize: 8 }}>Trading costs</div><div className="mono" style={{ marginTop: 5, fontSize: 11 }}>{formatMoney(customResult.tradingCosts)}</div></div>
            <div><div className="eyebrow" style={{ fontSize: 8 }}>Max drawdown</div><div className="mono" style={{ marginTop: 5, fontSize: 11 }}>{customResult.maxDrawdownPercent.toFixed(2)}%</div></div>
          </div>
          <p className="muted" style={{ margin: '9px 0 0', fontSize: 9 }}>{customResult.assumptions.description}</p>
        </div>}
      </form>
    </div>
    <div data-testid="benchmark-approval-policy" style={{ marginTop: 14, padding: 13, borderRadius: 10, border: `1px solid hsl(var(--${backtest.benchmarkPolicy.passed ? 'primary' : 'destructive'}) / .25)`, background: `hsl(var(--${backtest.benchmarkPolicy.passed ? 'primary' : 'destructive'}) / .06)` }}>
      <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>{backtest.benchmarkPolicy.passed ? <Check size={14} className="text-teal" /> : <CircleAlert size={14} className="text-red" />}<strong style={{ fontSize: 11 }}>{backtest.benchmarkPolicy.passed ? 'Benchmark policy passed' : 'Benchmark policy failed — live mode remains locked'}</strong></div>
      <p className="muted" style={{ margin: '7px 0 0', fontSize: 10, lineHeight: 1.55 }}>{backtest.benchmarkPolicy.rationale} Required excess return: greater than {formatPct(backtest.benchmarkPolicy.requiredMinimumExcessReturnPercent)}. Actual: {formatPct(backtest.excessReturnPercent)}.</p>
    </div>
    <div style={{ overflowX: 'auto', marginTop: 14 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720, fontSize: 10 }}>
        <thead><tr style={{ color: 'hsl(var(--muted-foreground))', textAlign: 'left', borderBottom: '1px solid hsl(var(--border))' }}><th style={{ padding: '9px 8px' }}>Pre-declared rule</th><th>Setup</th><th>Development gross / net</th><th>Holdout gross / net</th><th>Holdout drawdown</th><th>Holdout turnover</th></tr></thead>
        <tbody>{backtest.candidates.map((candidate) => <tr key={candidate.id} data-testid={`strategy-candidate-${candidate.id}`} style={{ borderBottom: '1px solid hsl(var(--border) / .6)', background: candidate.selected ? 'hsl(var(--primary) / .05)' : 'transparent' }}><td style={{ padding: '10px 8px', fontWeight: 700 }}>{candidate.name}{candidate.selected && <span className="tag tag-buy" style={{ marginLeft: 7 }}>Selected</span>}</td><td className="mono">SMA{candidate.movingAverageSessions} · ±{candidate.signalBandPercent}% · stop {candidate.stopLossPercent}% · cash {candidate.cashReservePercent}%</td><td className="mono">{formatPct(candidate.developmentGrossReturnPercent)} / {formatPct(candidate.developmentNetReturnPercent)}</td><td className="mono">{formatPct(candidate.holdoutGrossReturnPercent)} / {formatPct(candidate.holdoutNetReturnPercent)}</td><td className="mono">{candidate.holdoutMaxDrawdownPercent.toFixed(2)}%</td><td className="mono">{candidate.holdoutTurnoverPercent.toFixed(1)}%</td></tr>)}</tbody>
      </table>
      <div className="muted" style={{ fontSize: 9, marginTop: 8 }}>Selection rule: {backtest.methodology.selectionRule}. Holdout results were not used to choose the winner.</div>
    </div>
    <div className="strategy-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, marginTop: 14 }}>
      {backtest.regimes.map((item) => <div key={item.regime} data-testid={`regime-${item.regime.toLowerCase()}`} style={{ padding: 12, borderRadius: 10, border: '1px solid hsl(var(--border))', background: 'hsl(var(--secondary) / .35)' }}><div className="eyebrow" style={{ fontSize: 8 }}>{item.regime} · {item.sessions} sessions</div><div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 9, fontSize: 11 }}><span className="muted">Strategy</span><span className="mono">{formatPct(item.returnPercent)}</span></div><div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 6, fontSize: 11 }}><span className="muted">FTSE</span><span className="mono">{formatPct(item.benchmarkReturnPercent)}</span></div><div className="muted" style={{ fontSize: 9, marginTop: 9 }}>{item.startDate} → {item.endDate}</div></div>)}
    </div>
    <p className="muted" style={{ margin: '13px 0 0', fontSize: 10 }}>Base cost model: {backtest.costAssumptions.description} Only the base scenario's net holdout return and net excess return versus the FTSE 100 drive the safety gate; low, high, and custom broker costs are comparison-only. Snapshot as of {backtest.snapshotAsOfDate} ({backtest.snapshotAgeDays} days old) · Source: {backtest.dataSource} · {backtest.priceField} · SMA signals use each close and execute on the next available session.</p>
  </section>;
}

function RiskSettingsModal({ settings, pending, onClose, onSave }: { settings: RiskSettings; pending: boolean; onClose: () => void; onSave: (settings: RiskSettings) => void }) {
  const [values, setValues] = useState(settings);
  const fields = [
    { key: 'maxPositionPercent' as const, label: 'Maximum position', min: 5, max: 50, help: 'Caps any single holding as a percentage of portfolio value.' },
    { key: 'stopLossPercent' as const, label: 'Stop-loss', min: 2, max: 20, help: 'Closes a paper holding after this loss from its average entry.' },
    { key: 'cashReservePercent' as const, label: 'Cash reserve', min: 10, max: 60, help: 'Keeps this share of portfolio value uninvested.' },
  ];
  return <div className="modal-backdrop"><div className="modal" data-testid="modal-risk-settings">
    <div style={{ display: 'flex', justifyContent: 'space-between' }}><div><div className="eyebrow">Paper strategy controls</div><h2 style={{ margin: '7px 0 0', fontSize: 20 }}>Tune risk limits</h2></div><button className="button button-plain" onClick={onClose}><X size={17} /></button></div>
    <p className="muted" style={{ fontSize: 11, lineHeight: 1.6 }}>Saving reruns the historical simulation and keeps execution in paper mode.</p>
    {fields.map((field) => <label key={field.key} style={{ display: 'block', marginTop: 17 }}><span className="eyebrow">{field.label} ({field.min}–{field.max}%)</span><input data-testid={`input-${field.key}`} className="field mono" type="number" min={field.min} max={field.max} step="1" value={values[field.key]} onChange={(event) => setValues({ ...values, [field.key]: Number(event.target.value) })} style={{ marginTop: 7 }} /><span className="muted" style={{ display: 'block', fontSize: 10, marginTop: 6 }}>{field.help}</span></label>)}
    <div style={{ display: 'flex', gap: 9, marginTop: 24 }}><button className="button button-quiet" onClick={onClose} style={{ flex: 1 }}>Cancel</button><button data-testid="button-save-risk" className="button button-primary" disabled={pending || fields.some((field) => values[field.key] < field.min || values[field.key] > field.max)} onClick={() => onSave(values)} style={{ flex: 1 }}>{pending ? <RefreshCw size={14} className="animate-spin" /> : <ShieldCheck size={14} />}Save & rerun</button></div>
  </div></div>;
}

function MetricCard({ label, value, sub, icon, accent, action }: { label: string; value: string; sub: string; icon: ReactNode; accent?: 'teal' | 'red'; action?: ReactNode }) {
  return <div className="panel" style={{ minHeight: 154, padding: 18 }}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: accent === 'red' ? 'hsl(var(--destructive))' : accent === 'teal' ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))' }}><span className="eyebrow">{label}</span>{icon}</div><div className={`metric-value ${accent === 'red' ? 'text-red' : accent === 'teal' ? 'text-teal' : ''}`} style={{ marginTop: 20 }}>{value}</div><div className="muted" style={{ fontSize: 11, marginTop: 9 }}>{sub}</div>{action}</div>;
}

function MarketPanel({ assets }: { assets: Asset[] }) {
  const movingAverageSessions = assets[0]?.movingAverageSessions ?? 50;
  return <section className="panel" style={{ overflow: 'hidden' }}><div className="panel-header" style={{ padding: '18px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><div><div className="eyebrow">Systematic universe</div><h2 style={{ margin: '6px 0 0', fontSize: 15, letterSpacing: '-.02em' }}>UK shares & crypto pulse</h2></div><span className="tag tag-hold"><Activity size={11} />{movingAverageSessions}-day trend</span></div>{assets.length === 0 ? <EmptyState icon={<Eye size={19} />} title="No market data yet" copy="The simulated universe has not returned any instruments." /> : <div style={{ overflowX: 'auto' }}><table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 600 }}><thead><tr style={{ textAlign: 'left', color: 'hsl(var(--muted-foreground))' }}>{['Instrument', 'Last', '1D move', `vs SMA ${movingAverageSessions}`, 'Trend', 'Signal'].map((heading) => <th key={heading} className="eyebrow" style={{ padding: '13px 20px', fontWeight: 500, whiteSpace: 'nowrap' }}>{heading}</th>)}</tr></thead><tbody>{assets.map((asset) => <AssetRow key={asset.symbol} asset={asset} />)}</tbody></table></div>}</section>;
}

function AssetRow({ asset }: { asset: Asset }) {
  const points = asset.chart?.length ? asset.chart : [30, 32, 31, 35, 34, 38, 41];
  const min = Math.min(...points); const max = Math.max(...points); const path = points.map((point, index) => `${(index / Math.max(points.length - 1, 1)) * 100},${46 - ((point - min) / Math.max(max - min, 1)) * 38}`).join(' ');
  const positive = asset.change >= 0;
  return <tr className="table-row" data-testid={`row-asset-${asset.symbol}`} style={{ borderTop: '1px solid hsl(var(--border))' }}><td style={{ padding: '14px 20px' }}><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div style={{ width: 31, height: 31, display: 'grid', placeItems: 'center', borderRadius: 8, color: 'hsl(var(--primary))', background: 'hsl(var(--primary) / .09)', fontFamily: 'var(--app-font-mono)', fontSize: 9 }}>{asset.symbol.slice(0, 3)}</div><div><div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ fontWeight: 800, fontSize: 12 }}>{asset.symbol}</span>{asset.assetClass === 'CRYPTO' && <span className="tag tag-hold" style={{ padding: '2px 5px', fontSize: 8 }}>CRYPTO</span>}</div><div className="muted" style={{ fontSize: 10, marginTop: 3 }}>{asset.name}</div></div></div></td><td className="mono" style={{ padding: '14px 20px', fontSize: 12 }}>{formatMoney(asset.price)}</td><td style={{ padding: '14px 20px' }}><div className={positive ? 'text-teal' : 'text-red'} style={{ fontFamily: 'var(--app-font-mono)', fontSize: 11 }}>{positive ? '+' : ''}{asset.change.toFixed(2)}</div><div className={positive ? 'text-teal' : 'text-red'} style={{ fontSize: 10, marginTop: 3 }}>{formatPct(asset.changePercent)}</div></td><td className="mono" style={{ padding: '14px 20px', fontSize: 11, color: asset.price >= asset.sma50 ? 'hsl(var(--primary))' : 'hsl(var(--destructive))' }}>{formatMoney(asset.sma50)}</td><td style={{ padding: '14px 20px' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: asset.trend === 'UPTREND' ? 'hsl(var(--primary))' : asset.trend === 'DOWNTREND' ? 'hsl(var(--destructive))' : 'hsl(var(--accent))', fontSize: 11 }}>{asset.trend === 'UPTREND' ? <TrendingUp size={13} /> : asset.trend === 'DOWNTREND' ? <TrendingDown size={13} /> : <Minus size={13} />}{asset.trend === 'UPTREND' ? 'Uptrend' : asset.trend === 'DOWNTREND' ? 'Downtrend' : 'Neutral'}</span></td><td style={{ padding: '14px 20px' }}><span className={`tag ${asset.action === 'BUY' ? 'tag-buy' : asset.action === 'SELL' ? 'tag-sell' : 'tag-hold'}`}>{asset.action}</span></td><td style={{ padding: '14px 20px 14px 0', width: 90 }}><svg className="sparkline" viewBox="0 0 100 58" preserveAspectRatio="none"><polyline points={path} fill="none" stroke={positive ? 'hsl(var(--primary))' : 'hsl(var(--destructive))'} strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg></td></tr>;
}

function SignalPanel({ signals, onSignals }: { signals: Signal[]; onSignals: () => void }) {
  return <section className="panel" style={{ overflow: 'hidden' }}><div className="panel-header" style={{ padding: '18px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><div><div className="eyebrow">Latest decisions</div><h2 style={{ margin: '6px 0 0', fontSize: 15, letterSpacing: '-.02em' }}>Signal log</h2></div><button data-testid="button-view-all-signals" className="button button-plain" onClick={onSignals} style={{ fontSize: 11 }}>View all <ChevronRight size={13} /></button></div>{signals.length === 0 ? <EmptyState icon={<Sparkles size={19} />} title="No signals yet" copy="New signals will appear when the trend model detects a move." /> : <div>{signals.slice(0, 5).map((signal) => <div key={signal.id} data-testid={`row-signal-${signal.id}`} className="table-row" style={{ display: 'flex', gap: 12, padding: '15px 20px', borderTop: '1px solid hsl(var(--border))' }}><div style={{ width: 30, height: 30, display: 'grid', placeItems: 'center', flexShrink: 0, borderRadius: 8, color: signal.action === 'BUY' ? 'hsl(var(--primary))' : 'hsl(var(--destructive))', background: signal.action === 'BUY' ? 'hsl(var(--primary) / .1)' : 'hsl(var(--destructive) / .1)' }}>{signal.action === 'BUY' ? <ArrowUpRight size={15} /> : <ArrowDownLeft size={15} />}</div><div style={{ minWidth: 0, flex: 1 }}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span style={{ fontSize: 12, fontWeight: 800 }}>{signal.symbol} · {signalOrderLabel(signal)}</span><span className="muted mono" style={{ fontSize: 9 }}>{dateTime.format(new Date(signal.createdAt))}</span></div><SignalStatus signal={signal} compact /><div className="muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 10, marginTop: 5 }}>{signal.reason}</div></div></div>)}</div>}</section>;
}

function PositionsPanel({ positions }: { positions: Position[] }) {
  return <section className="panel" style={{ overflow: 'hidden' }}>
    <div className="panel-header" style={{ padding: '18px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
      <div><div className="eyebrow">Automatic allocation</div><h2 style={{ margin: '6px 0 0', fontSize: 15, letterSpacing: '-.02em' }}>Paper holdings</h2></div>
      <span className="tag tag-buy"><Sparkles size={11} />Auto-managed</span>
    </div>
    {positions.length === 0 ? <EmptyState icon={<BarChart3 size={19} />} title="No holdings yet" copy="New BUY signals invest available paper cash equally. A later SELL signal automatically closes the matching holding." /> : <div style={{ overflowX: 'auto' }}><table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 620 }}><thead><tr style={{ textAlign: 'left', color: 'hsl(var(--muted-foreground))' }}>{['Holding', 'Quantity', 'Avg price', 'Current', 'Value', 'P&L'].map((heading) => <th key={heading} className="eyebrow" style={{ padding: '13px 20px', fontWeight: 500, whiteSpace: 'nowrap' }}>{heading}</th>)}</tr></thead><tbody>{positions.map((position) => <tr key={position.id} data-testid={`row-position-${position.symbol}`} className="table-row" style={{ borderTop: '1px solid hsl(var(--border))' }}><td style={{ padding: '14px 20px' }}><div style={{ fontWeight: 800, fontSize: 12 }}>{position.symbol}</div><div className="muted" style={{ fontSize: 10, marginTop: 3 }}>{position.name}</div></td><td className="mono" style={{ padding: '14px 20px', fontSize: 11 }}>{position.quantity.toFixed(4)}</td><td className="mono" style={{ padding: '14px 20px', fontSize: 11 }}>{formatMoney(position.averagePrice)}</td><td className="mono" style={{ padding: '14px 20px', fontSize: 11 }}>{formatMoney(position.currentPrice)}</td><td className="mono" style={{ padding: '14px 20px', fontSize: 11 }}>{formatMoney(position.marketValue)}</td><td className={position.unrealizedPnl >= 0 ? 'text-teal' : 'text-red'} style={{ padding: '14px 20px', fontFamily: 'var(--app-font-mono)', fontSize: 11 }}>{position.unrealizedPnl >= 0 ? '+' : ''}{formatMoney(position.unrealizedPnl)}</td></tr>)}</tbody></table></div>}
  </section>;
}

function SignalLog({ signals }: { signals: Signal[] }) {
  return <section className="panel" style={{ overflow: 'hidden' }}><div className="panel-header" style={{ padding: '20px' }}><div className="eyebrow">Explainability layer</div><h2 style={{ margin: '7px 0 0', fontSize: 18 }}>Signal history</h2><p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>Paper orders execute in the next scheduled market session. Pending and completed orders are shown separately.</p></div>{signals.length === 0 ? <EmptyState icon={<Sparkles size={19} />} title="The log is quiet" copy="There are no model decisions to review yet." /> : <div style={{ overflowX: 'auto' }}><table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 820 }}><thead><tr style={{ textAlign: 'left' }}>{['Order', 'Status & schedule', 'Instrument', 'Price', 'SMA 50', 'Reason', 'Captured'].map((heading) => <th key={heading} className="eyebrow" style={{ padding: '14px 20px', whiteSpace: 'nowrap' }}>{heading}</th>)}</tr></thead><tbody>{signals.map((signal) => <tr key={signal.id} data-testid={`row-signal-detail-${signal.id}`} className="table-row" style={{ borderTop: '1px solid hsl(var(--border))' }}><td style={{ padding: '17px 20px' }}><span className={`tag ${signal.action === 'BUY' ? 'tag-buy' : 'tag-sell'}`}>{signal.action === 'BUY' ? <ArrowUpRight size={11} /> : <ArrowDownLeft size={11} />}{signalOrderLabel(signal)}</span></td><td style={{ padding: '17px 20px' }}><SignalStatus signal={signal} /></td><td style={{ padding: '17px 20px' }}><div style={{ fontWeight: 800, fontSize: 12 }}>{signal.symbol}</div><div className="muted" style={{ fontSize: 10, marginTop: 3 }}>{signal.name}</div></td><td className="mono" style={{ padding: '17px 20px', fontSize: 11 }}>{formatMoney(signal.price)}</td><td className="mono" style={{ padding: '17px 20px', fontSize: 11 }}>{formatMoney(signal.sma50)}</td><td style={{ padding: '17px 20px', fontSize: 11, maxWidth: 320 }}>{signal.reason}</td><td className="muted mono" style={{ padding: '17px 20px', fontSize: 10, whiteSpace: 'nowrap' }}>{dateTime.format(new Date(signal.createdAt))}</td></tr>)}</tbody></table></div>}</section>;
}

function Watchlist({ assets }: { assets: Asset[] }) {
  return <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(245px, 1fr))', gap: 13 }}>{assets.length === 0 ? <div className="panel" style={{ gridColumn: '1 / -1' }}><EmptyState icon={<Eye size={19} />} title="Watchlist is waiting" copy="The simulated UK universe will appear here when market data is available." /></div> : assets.map((asset) => <WatchCard key={asset.symbol} asset={asset} />)}</section>;
}

function WatchCard({ asset }: { asset: Asset }) {
  const positive = asset.change >= 0;
  return <div className="panel" data-testid={`card-watchlist-${asset.symbol}`} style={{ padding: 18 }}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}><div><div className="eyebrow">{asset.symbol} · {asset.assetClass === 'CRYPTO' ? 'CRYPTO' : asset.assetClass === 'BENCHMARK' ? 'BENCHMARK' : 'UK EQUITY'}</div><div style={{ fontSize: 13, fontWeight: 800, marginTop: 6 }}>{asset.name}</div></div><span className={`tag ${asset.action === 'BUY' ? 'tag-buy' : asset.action === 'SELL' ? 'tag-sell' : 'tag-hold'}`}>{asset.action}</span></div><div className="metric-value" style={{ marginTop: 26 }}>{formatMoney(asset.price)}</div><div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 9, fontSize: 11 }}><span className={positive ? 'text-teal' : 'text-red'}>{positive ? '+' : ''}{asset.change.toFixed(2)} ({formatPct(asset.changePercent)})</span><span className="muted">SMA {formatMoney(asset.sma50)}</span></div><div style={{ height: 1, background: 'hsl(var(--border))', margin: '18px 0 14px' }} /><div style={{ display: 'flex', gap: 7, alignItems: 'center', color: asset.trend === 'UPTREND' ? 'hsl(var(--primary))' : asset.trend === 'DOWNTREND' ? 'hsl(var(--destructive))' : 'hsl(var(--accent))', fontSize: 11 }}>{asset.trend === 'UPTREND' ? <TrendingUp size={14} /> : asset.trend === 'DOWNTREND' ? <TrendingDown size={14} /> : <Minus size={14} />}{asset.trend === 'UPTREND' ? 'Price is above trend' : asset.trend === 'DOWNTREND' ? 'Price is below trend' : 'Price is near trend'}</div></div>;
}

function EmptyState({ icon, title, copy }: { icon: ReactNode; title: string; copy: string }) {
  return <div style={{ minHeight: 180, display: 'grid', placeItems: 'center', textAlign: 'center', padding: 28 }}><div><div style={{ width: 38, height: 38, display: 'grid', placeItems: 'center', margin: '0 auto', borderRadius: 10, color: 'hsl(var(--muted-foreground))', background: 'hsl(var(--secondary))' }}>{icon}</div><div style={{ fontSize: 13, fontWeight: 800, marginTop: 13 }}>{title}</div><div className="muted" style={{ fontSize: 11, lineHeight: 1.55, maxWidth: 245, margin: '7px auto 0' }}>{copy}</div></div></div>;
}

function CashModal({ mode, cash, mutation, onClose, onSuccess }: { mode: CashMode; cash: number; mutation: ReturnType<typeof useDepositCash> | ReturnType<typeof useWithdrawCash>; onClose: () => void; onSuccess: (message: string) => void }) {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const numeric = Number(amount);
    if (!numeric || numeric <= 0) { setError('Enter an amount greater than £0.'); return; }
    if (mode === 'withdraw' && numeric > cash) { setError('That is more than your available paper cash.'); return; }
    setError('');
    mutation.mutate({ data: { amount: numeric } }, { onSuccess: () => onSuccess(`${mode === 'deposit' ? 'Added' : 'Withdrew'} ${formatMoney(numeric)} ${mode === 'deposit' ? 'to' : 'from'} paper cash.`), onError: () => setError('Cash update failed. Please try again.') });
  };
  return <div className="modal-backdrop"><div className="modal"><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}><div><div className="eyebrow">Mock GBP controls</div><h2 style={{ fontSize: 20, letterSpacing: '-.04em', margin: '7px 0 0' }}>{mode === 'deposit' ? 'Add paper cash' : 'Withdraw paper cash'}</h2></div><button data-testid="button-close-cash-modal" className="button button-plain" onClick={onClose}><X size={17} /></button></div><p className="muted" style={{ fontSize: 12, lineHeight: 1.6, margin: '13px 0 0' }}>{mode === 'deposit' ? 'Set a GBP balance for a controlled simulation. Nothing is transferred.' : `Available to withdraw: ${formatMoney(cash)}. This only changes your paper balance.`}</p><form onSubmit={submit}><label className="eyebrow" htmlFor="cash-amount" style={{ display: 'block', marginTop: 25 }}>Amount in GBP</label><div style={{ position: 'relative', marginTop: 8 }}><span className="mono muted" style={{ position: 'absolute', left: 13, top: 12 }}>£</span><input id="cash-amount" data-testid="input-cash-amount" className="field mono" style={{ paddingLeft: 28 }} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" autoFocus /></div>{error && <div data-testid="status-cash-error" style={{ color: 'hsl(var(--destructive))', fontSize: 11, marginTop: 10 }}>{error}</div>}<div style={{ display: 'flex', gap: 9, marginTop: 24 }}><button data-testid="button-cancel-cash" type="button" className="button button-quiet" onClick={onClose} style={{ flex: 1 }}>Cancel</button><button data-testid="button-submit-cash" type="submit" className="button button-primary" disabled={mutation.isPending} style={{ flex: 1 }}>{mutation.isPending ? <RefreshCw size={14} className="animate-spin" /> : mode === 'deposit' ? <Plus size={14} /> : <ArrowDownLeft size={14} />}{mutation.isPending ? 'Updating…' : mode === 'deposit' ? 'Add cash' : 'Withdraw'}</button></div></form></div></div>;
}

function BrokerModal({ onClose }: { onClose: () => void }) {
  const [provider, setProvider] = useState('Interactive Brokers UK');
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  return <div className="modal-backdrop"><div className="modal"><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}><div><div className="eyebrow" style={{ color: 'hsl(var(--accent))' }}>Compliance checkpoint</div><h2 style={{ fontSize: 20, letterSpacing: '-.04em', margin: '7px 0 0' }}>Connect a broker</h2></div><button data-testid="button-close-broker-modal" className="button button-plain" onClick={onClose}><X size={17} /></button></div><div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 20, padding: 13, borderRadius: 10, background: 'hsl(var(--accent) / .08)', border: '1px solid hsl(var(--accent) / .2)' }}><ShieldCheck size={17} className="text-amber" style={{ flexShrink: 0 }} /><p style={{ margin: 0, fontSize: 12, lineHeight: 1.65 }}>To trade with real UK funds, paste your Interactive Brokers UK or Alpaca UK API keys here. Otherwise, the app will safely remain in automatic simulation mode.</p></div><label className="eyebrow" htmlFor="broker-provider" style={{ display: 'block', marginTop: 22 }}>Broker</label><select id="broker-provider" data-testid="select-broker-provider" className="field" style={{ marginTop: 8 }} value={provider} onChange={(event) => setProvider(event.target.value)}><option>Interactive Brokers UK</option><option>Alpaca UK</option></select><label className="eyebrow" htmlFor="broker-key" style={{ display: 'block', marginTop: 16 }}>API key</label><input id="broker-key" data-testid="input-broker-key" className="field" style={{ marginTop: 8 }} value={key} onChange={(event) => setKey(event.target.value)} placeholder={`${provider} API key`} /><label className="eyebrow" htmlFor="broker-secret" style={{ display: 'block', marginTop: 16 }}>Secret key</label><input id="broker-secret" data-testid="input-broker-secret" className="field" style={{ marginTop: 8 }} type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="Secret key" /><div style={{ display: 'flex', gap: 9, marginTop: 24 }}><button data-testid="button-stay-simulation" className="button button-quiet" onClick={onClose} style={{ flex: 1 }}>Stay in simulation</button><button data-testid="button-save-broker" className="button button-primary" onClick={onClose} style={{ flex: 1 }} disabled={!key || !secret}><KeyRound size={14} />Save connection</button></div><div className="muted" style={{ fontSize: 10, lineHeight: 1.5, marginTop: 14 }}>Credentials are not sent by this paper-trading surface until a compliant broker connection is configured.</div></div></div>;
}

function DashboardSkeleton({ user }: { user: User }) {
  return <div className="app-shell"><div style={{ maxWidth: 1500, margin: '0 auto', padding: 'clamp(20px, 3vw, 38px)' }}><div className="eyebrow">Loading workspace</div><h1 style={{ margin: '10px 0 28px', fontSize: 28 }}>Preparing the signal desk for {user.email.split('@')[0]}.</h1><div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>{[1, 2, 3, 4].map((item) => <div key={item} className="panel skeleton" style={{ height: 154 }} />)}</div><div className="panel skeleton" style={{ height: 420, marginTop: 16 }} /></div></div>;
}

function DashboardError({ onRetry }: { onRetry: () => void }) {
  return <div className="auth-backdrop"><div className="auth-grid" /><div className="auth-card" style={{ textAlign: 'center' }}><div className="brand-mark" style={{ margin: '0 auto', background: 'hsl(var(--destructive) / .14)', color: 'hsl(var(--destructive))' }}><CircleAlert size={18} /></div><h1 style={{ fontSize: 23, margin: '21px 0 0', letterSpacing: '-.04em' }}>The signal desk is offline.</h1><p className="muted" style={{ fontSize: 12, lineHeight: 1.6, margin: '10px auto 0', maxWidth: 270 }}>We could not load your simulated market data. Your session is still safe.</p><button data-testid="button-retry-dashboard" className="button button-primary" onClick={onRetry} style={{ marginTop: 23 }}><RefreshCw size={14} />Retry data feed</button></div></div>;
}

function NotFound() {
  return <div className="auth-backdrop"><div className="auth-card" style={{ textAlign: 'center' }}><div className="eyebrow">404 / quiet market</div><h1 style={{ fontSize: 27, margin: '14px 0 0' }}>Nothing on this route.</h1><p className="muted" style={{ fontSize: 12, marginTop: 9 }}>Return to the Northstar workspace.</p><a data-testid="link-return-home" className="button button-primary" href="/" style={{ marginTop: 22 }}>Return home</a></div></div>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><AppRouter /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;
