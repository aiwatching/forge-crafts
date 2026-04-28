import { useForgeFetch, useInject } from '@forge/craft';

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

const COMPOSE_SERVICES = ['mariadb', 'redis', 'campusmgr', 'web-server'];

function badge(state: string, health: string) {
  const s = (state || '').toLowerCase();
  const h = (health || '').toLowerCase();
  let color = 'var(--text-secondary)';
  let label = state || '—';
  if (s === 'running') {
    if (h === 'healthy') {
      color = '#22c55e';
      label = 'healthy';
    } else if (h === 'starting') {
      color = '#eab308';
      label = 'starting';
    } else if (h === 'unhealthy') {
      color = '#ef4444';
      label = 'unhealthy';
    } else {
      color = '#22c55e';
      label = 'running';
    }
  } else if (s === 'exited' || s === 'dead') {
    color = '#ef4444';
    label = s;
  } else if (s === 'created' || s === 'paused') {
    color = '#eab308';
    label = s;
  } else if (!state) {
    color = 'var(--text-secondary)';
    label = 'absent';
  }
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded font-mono"
      style={{ background: `${color}22`, color }}
    >
      {label}
    </span>
  );
}

export default function ServerMgmt() {
  const inject = useInject();
  const { data, loading, error, refetch } = useForgeFetch<StatusPayload>(
    '/api/crafts/server-mgmt/status',
  );

  const run = async (cmd: string) => {
    await inject(cmd);
    setTimeout(() => refetch(), 1500);
  };

  const upAll = () => run('build-tools/up.sh up');
  const downAll = () => run('build-tools/up.sh down');
  const rebuildAll = () => run('build-tools/up.sh rebuild');
  const statusAll = () => run('build-tools/up.sh status');
  const logsAll = () => run('build-tools/up.sh logs');

  const upOne = (svc: string) => run(`build-tools/up.sh up ${svc}`);
  const rebuildOne = (svc: string) => run(`build-tools/up.sh rebuild ${svc}`);
  const stopOne = (svc: string) => run(`build-tools/up.sh stop ${svc}`);
  const logsOne = (svc: string) => run(`build-tools/up.sh logs ${svc}`);
  const restartOne = (svc: string) => run(`build-tools/up.sh restart ${svc}`);

  const baremetalStart = () => run('build-tools/scripts/start-web-server.sh -d');
  const baremetalStartBuild = () => run('build-tools/scripts/start-web-server.sh -d --build');
  const baremetalStop = () => run('build-tools/scripts/start-web-server.sh stop');
  const baremetalStatus = () => run('build-tools/scripts/start-web-server.sh status');
  const tailWsLog = () => run('tail -f /tmp/fortinac-web-server.log');

  const byName: Record<string, ServiceState> = {};
  for (const s of data?.services || []) byName[s.name] = s;

  const Btn = (props: {
    onClick: () => void;
    children: React.ReactNode;
    tone?: 'accent' | 'danger' | 'muted';
  }) => {
    const tone = props.tone || 'accent';
    const base =
      tone === 'danger'
        ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25'
        : tone === 'muted'
        ? 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)]'
        : 'bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30';
    return (
      <button
        onClick={props.onClick}
        className={`text-[10px] px-2 py-1 rounded ${base} transition-colors`}
      >
        {props.children}
      </button>
    );
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-auto p-4 gap-3 text-xs">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-[var(--text-primary)]">
            🐳 Server Management
          </div>
          <div className="text-[10px] text-[var(--text-secondary)] mt-0.5">
            build-tools/up.sh · build-tools/scripts/start-web-server.sh
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Btn onClick={refetch} tone="muted">
            {loading ? '…refreshing' : '↻ refresh'}
          </Btn>
        </div>
      </div>

      {/* Stack-wide actions */}
      <div className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-3 flex flex-col gap-2">
        <div className="text-[11px] font-semibold text-[var(--text-primary)]">
          Stack (docker compose)
        </div>
        <div className="text-[10px] text-[var(--text-secondary)] -mt-1">
          Wraps <code>build-tools/up.sh</code>. Commands are pasted into the bound
          terminal so you see compose output live.
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Btn onClick={upAll}>▶ up -d (all)</Btn>
          <Btn onClick={rebuildAll}>↻ rebuild + recreate (all)</Btn>
          <Btn onClick={statusAll} tone="muted">ⓘ status</Btn>
          <Btn onClick={logsAll} tone="muted">≡ logs (follow)</Btn>
          <Btn onClick={downAll} tone="danger">■ down</Btn>
        </div>
      </div>

      {/* Per-service grid */}
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
                <tr
                  key={name}
                  className="border-t border-[var(--border)] hover:bg-[var(--bg-tertiary)]/50"
                >
                  <td className="px-3 py-1.5 font-mono text-[var(--text-primary)]">
                    {name}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[var(--text-secondary)]">
                    {s?.container || `fortinac-${name}`}
                  </td>
                  <td className="px-3 py-1.5">
                    {badge(s?.state || '', s?.health || '')}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-[var(--text-secondary)]">
                    {s?.ports || '—'}
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center justify-end gap-1">
                      <Btn onClick={() => upOne(name)}>up</Btn>
                      <Btn onClick={() => restartOne(name)} tone="muted">restart</Btn>
                      <Btn onClick={() => rebuildOne(name)}>rebuild</Btn>
                      <Btn onClick={() => logsOne(name)} tone="muted">logs</Btn>
                      <Btn onClick={() => stopOne(name)} tone="danger">stop</Btn>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Bare-metal web-server */}
      <div className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-[var(--text-primary)]">
              Bare-metal web-server (java -jar)
            </div>
            <div className="text-[10px] text-[var(--text-secondary)] mt-0.5">
              Skips docker; runs the WAR directly. Needs <code>mariadb</code> +{' '}
              <code>redis</code> already up. Profile <code>mariadb-dev</code>.
            </div>
          </div>
          <div>
            {data?.warServerRunning ? (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                style={{ background: '#22c55e22', color: '#22c55e' }}
              >
                running PID {data.warServerPid}
              </span>
            ) : (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
              >
                stopped
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Btn onClick={baremetalStart}>▶ start (detached)</Btn>
          <Btn onClick={baremetalStartBuild}>▶ build + start</Btn>
          <Btn onClick={baremetalStatus} tone="muted">ⓘ status</Btn>
          <Btn onClick={tailWsLog} tone="muted">≡ tail log</Btn>
          <Btn onClick={baremetalStop} tone="danger">■ stop</Btn>
        </div>
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

      <div className="text-[10px] text-[var(--text-secondary)] mt-1">
        compose file: <code>{data?.composeFile || 'build-tools/docker/docker-compose.yml'}</code>
      </div>
    </div>
  );
}
