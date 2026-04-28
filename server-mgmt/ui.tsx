import { useState, useEffect, useRef } from 'react';
import { useProject, useForgeFetch } from '@forge/craft';

const CRAFT = '/api/crafts/server-mgmt';
const COMPOSE_SERVICES = ['mariadb', 'redis', 'campusmgr', 'web-server'];

type ServiceState = {
  name: string;
  container: string;
  state: string;
  status: string;
  health: string;
  ports: string;
};

type StatusPayload = {
  ok: boolean;
  services: ServiceState[];
  warServerRunning: boolean;
  warServerPid: string;
  composeFile: string;
  error?: string;
};

type ActionResult = { ok?: boolean; error?: string; logFile?: string; detached?: boolean; output?: string };

function badge(state: string, health: string) {
  const s = (state || '').toLowerCase();
  const h = (health || '').toLowerCase();
  let color = 'var(--text-secondary)';
  let label = state || 'absent';
  if (s === 'running') {
    if (h === 'healthy') { color = '#22c55e'; label = 'healthy'; }
    else if (h === 'starting') { color = '#eab308'; label = 'starting'; }
    else if (h === 'unhealthy') { color = '#ef4444'; label = 'unhealthy'; }
    else { color = '#22c55e'; label = 'running'; }
  } else if (s === 'exited' || s === 'dead') { color = '#ef4444'; label = s; }
  else if (s === 'created' || s === 'paused' || s === 'restarting') { color = '#eab308'; label = s; }
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded font-mono"
      style={{ background: `${color}22`, color }}>
      {label}
    </span>
  );
}

export default function ServerMgmt() {
  const { projectPath } = useProject();
  const { data, loading, error, refetch } = useForgeFetch<StatusPayload>(`${CRAFT}/status`);

  const [busy, setBusy] = useState<string>('');
  const [actionMsg, setActionMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [activeLog, setActiveLog] = useState<string>('');
  const [logBody, setLogBody] = useState<string>('');
  const [logTailing, setLogTailing] = useState<boolean>(false);
  const tailTimer = useRef<any>(null);

  const pq = `projectPath=${encodeURIComponent(projectPath)}`;

  // Poll the active log file while tailing.
  useEffect(() => {
    if (!logTailing || !activeLog) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`${CRAFT}/log?${pq}&file=${encodeURIComponent(activeLog)}`);
        const d = await r.json();
        if (!cancelled) setLogBody(d.log || '');
      } catch { /* ignore */ }
      if (!cancelled) tailTimer.current = setTimeout(tick, 1500);
    };
    tick();
    return () => { cancelled = true; if (tailTimer.current) clearTimeout(tailTimer.current); };
  }, [logTailing, activeLog, pq]);

  const post = async (path: string, body?: any): Promise<ActionResult> => {
    const r = await fetch(`${CRAFT}${path}?${pq}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    try { return await r.json(); } catch { return { ok: false, error: `HTTP ${r.status}` }; }
  };

  const runAction = async (
    label: string,
    fn: () => Promise<ActionResult>,
    { tailFile, refreshDelay = 800 }: { tailFile?: string; refreshDelay?: number } = {},
  ) => {
    setBusy(label);
    setActionMsg(null);
    if (tailFile) {
      setActiveLog(tailFile);
      setLogBody('(starting…)');
      setLogTailing(true);
    }
    try {
      const res = await fn();
      if (res.error || res.ok === false) {
        setActionMsg({ text: res.error || `${label} failed`, ok: false });
      } else {
        setActionMsg({
          text: res.detached ? `${label} started — tailing ${res.logFile}` : `${label} OK`,
          ok: true,
        });
        if (res.logFile && !tailFile) {
          setActiveLog(res.logFile);
          setLogTailing(true);
        }
        if (res.output && !res.logFile) {
          setLogBody(res.output);
          setActiveLog(`(${label} output)`);
          setLogTailing(false);
        }
      }
    } catch (e: any) {
      setActionMsg({ text: `network: ${e.message || e}`, ok: false });
    } finally {
      setBusy('');
      setTimeout(refetch, refreshDelay);
    }
  };

  // Stack-wide
  const upAll = () => runAction('up (all)', () => post('/up', {}));
  const downAll = () => runAction('down (all)', () => post('/down', {}));
  const rebuildAll = () => runAction('rebuild (all)', () => post('/rebuild', {}));

  // Per-service
  const upOne = (svc: string) => runAction(`up ${svc}`, () => post('/up', { service: svc }));
  const restartOne = (svc: string) => runAction(`restart ${svc}`, () => post('/restart', { service: svc }));
  const stopOne = (svc: string) => runAction(`stop ${svc}`, () => post('/stop', { service: svc }));
  const rebuildOne = (svc: string) => runAction(`rebuild ${svc}`, () => post('/rebuild', { service: svc }));
  const tailComposeLog = (svc?: string) => {
    const file = svc ? `/tmp/fortinac-craft-logs-${svc}.log` : `/tmp/fortinac-craft-logs.log`;
    runAction(svc ? `logs ${svc}` : 'logs (all)', () => post('/follow-logs', { service: svc }), { tailFile: file });
  };

  // Bare-metal
  const wsStart = () => runAction('ws start', () => post('/ws-start', { build: false }));
  const wsBuildStart = () => runAction('ws build+start', () => post('/ws-start', { build: true }));
  const wsStop = () => runAction('ws stop', () => post('/ws-stop', {}));
  const wsTail = () => {
    setActiveLog('/tmp/fortinac-web-server.log');
    setLogTailing(true);
  };

  const stopTail = () => setLogTailing(false);

  const byName: Record<string, ServiceState> = {};
  for (const s of data?.services || []) byName[s.name] = s;

  const Btn = ({
    onClick, children, tone = 'accent', disabled,
  }: {
    onClick: () => void;
    children: React.ReactNode;
    tone?: 'accent' | 'danger' | 'muted' | 'success';
    disabled?: boolean;
  }) => {
    const cls =
      tone === 'danger' ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25'
      : tone === 'success' ? 'bg-green-500/15 text-green-400 hover:bg-green-500/25'
      : tone === 'muted' ? 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)]'
      : 'bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30';
    return (
      <button
        onClick={onClick}
        disabled={disabled || !!busy}
        className={`text-[10px] px-2 py-1 rounded transition-colors ${cls}`}
        style={{ opacity: disabled || busy ? 0.5 : 1, cursor: disabled || busy ? 'not-allowed' : 'pointer' }}
      >
        {children}
      </button>
    );
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-auto p-4 gap-3 text-xs">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-[var(--text-primary)]">🐳 Server Management</div>
          <div className="text-[10px] text-[var(--text-secondary)] mt-0.5">
            build-tools/up.sh · build-tools/scripts/start-web-server.sh
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {busy && <span className="text-[10px] text-[var(--text-secondary)]">⏳ {busy}…</span>}
          <Btn onClick={refetch} tone="muted">{loading ? '…' : '↻'} refresh</Btn>
        </div>
      </div>

      {/* Action result banner */}
      {actionMsg && (
        <div className={`rounded px-2 py-1.5 text-[10px] font-mono ${
          actionMsg.ok ? 'bg-green-500/10 text-green-400 border border-green-500/30'
                       : 'bg-red-500/10 text-red-400 border border-red-500/30'
        }`}>
          {actionMsg.text}
        </div>
      )}

      {/* Stack-wide */}
      <div className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-3 flex flex-col gap-2">
        <div className="text-[11px] font-semibold text-[var(--text-primary)]">Stack (docker compose)</div>
        <div className="text-[10px] text-[var(--text-secondary)] -mt-1">
          Wraps <code>build-tools/up.sh</code>. Long ops (rebuild) detach and stream
          to a log file shown in the Output panel below.
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Btn onClick={upAll} tone="success">▶ up -d (all)</Btn>
          <Btn onClick={rebuildAll}>↻ rebuild + recreate (all)</Btn>
          <Btn onClick={() => tailComposeLog()} tone="muted">≡ logs (all)</Btn>
          <Btn onClick={downAll} tone="danger">■ down</Btn>
        </div>
      </div>

      {/* Per-service */}
      <div className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] overflow-hidden">
        <div className="px-3 py-2 text-[11px] font-semibold text-[var(--text-primary)] border-b border-[var(--border)]">
          Services
        </div>
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-[10px] text-[var(--text-secondary)] uppercase">
              <th className="text-left px-3 py-1.5 font-normal">Service</th>
              <th className="text-left px-3 py-1.5 font-normal">Container</th>
              <th className="text-left px-3 py-1.5 font-normal">State</th>
              <th className="text-left px-3 py-1.5 font-normal">Ports</th>
              <th className="text-right px-3 py-1.5 font-normal">Actions</th>
            </tr>
          </thead>
          <tbody>
            {COMPOSE_SERVICES.map((name) => {
              const s = byName[name];
              return (
                <tr key={name} className="border-t border-[var(--border)] hover:bg-[var(--bg-tertiary)]/50">
                  <td className="px-3 py-1.5 font-mono text-[var(--text-primary)]">{name}</td>
                  <td className="px-3 py-1.5 font-mono text-[var(--text-secondary)]">{s?.container || `fortinac-${name}`}</td>
                  <td className="px-3 py-1.5">{badge(s?.state || '', s?.health || '')}</td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-[var(--text-secondary)]">{s?.ports || '—'}</td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center justify-end gap-1">
                      <Btn onClick={() => upOne(name)} tone="success">up</Btn>
                      <Btn onClick={() => restartOne(name)} tone="muted">restart</Btn>
                      <Btn onClick={() => rebuildOne(name)}>rebuild</Btn>
                      <Btn onClick={() => tailComposeLog(name)} tone="muted">logs</Btn>
                      <Btn onClick={() => stopOne(name)} tone="danger">stop</Btn>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Bare-metal */}
      <div className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-[var(--text-primary)]">
              Bare-metal web-server (java -jar)
            </div>
            <div className="text-[10px] text-[var(--text-secondary)] mt-0.5">
              Skips docker; runs the WAR directly. Needs <code>mariadb</code> + <code>redis</code> already up.
              Profile <code>mariadb-dev</code>. Log: <code>/tmp/fortinac-web-server.log</code>.
            </div>
          </div>
          <div>
            {data?.warServerRunning ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                style={{ background: '#22c55e22', color: '#22c55e' }}>
                running PID {data.warServerPid}
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                stopped
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Btn onClick={wsStart} tone="success">▶ start (detached)</Btn>
          <Btn onClick={wsBuildStart}>▶ build + start</Btn>
          <Btn onClick={wsTail} tone="muted">≡ tail log</Btn>
          <Btn onClick={wsStop} tone="danger">■ stop</Btn>
        </div>
      </div>

      {/* Output / log viewer */}
      <div className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] overflow-hidden flex flex-col">
        <div className="px-3 py-2 text-[11px] font-semibold text-[var(--text-primary)] border-b border-[var(--border)] flex items-center justify-between">
          <div>
            Output {activeLog && (
              <span className="font-mono text-[10px] text-[var(--text-secondary)] ml-2">{activeLog}</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {logTailing && <span className="text-[10px] text-[var(--accent)]">● tailing</span>}
            {activeLog && (
              logTailing
                ? <Btn onClick={stopTail} tone="muted">pause</Btn>
                : <Btn onClick={() => setLogTailing(true)} tone="muted">resume</Btn>
            )}
            <Btn onClick={() => { setLogBody(''); setActiveLog(''); setLogTailing(false); }} tone="muted">clear</Btn>
          </div>
        </div>
        <pre className="flex-1 overflow-auto p-3 text-[10px] font-mono text-[var(--text-secondary)] whitespace-pre-wrap min-h-[140px] max-h-[320px]">
{logBody || '(no output yet — click an action above)'}
        </pre>
      </div>

      {/* Errors */}
      {error && (
        <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-[10px] text-red-400 font-mono">
          fetch error: {String(error)}
        </div>
      )}
      {data?.error && (
        <div className="rounded border border-yellow-500/40 bg-yellow-500/10 p-2 text-[10px] text-yellow-300 font-mono whitespace-pre-wrap">
          docker probe: {data.error}
        </div>
      )}

      <div className="text-[10px] text-[var(--text-secondary)]">
        compose file: <code>{data?.composeFile || 'build-tools/docker/docker-compose.yml'}</code>
      </div>
    </div>
  );
}
