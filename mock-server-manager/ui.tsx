import { useState, useEffect, useCallback } from 'react';
import { useProject, useForgeFetch, useInject } from '@forge/craft';

const CRAFT = '/api/crafts/mock-server-manager';

// ── Types ───────────────────────────────────────────────────────────────

interface StatusData {
  running: boolean;
  pid?: string;
  port: string;
  healthy?: boolean;
  log?: string;
}

interface StoresData {
  stores: Record<string, { recordCount: number; sizeBytes: number }>;
}

interface StoreData {
  name: string;
  data: { records?: any[]; globals?: any; [k: string]: any };
  error?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function Badge({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium"
      style={{
        background: on ? 'rgba(52,211,153,0.15)' : 'rgba(248,113,113,0.15)',
        color: on ? '#34d399' : '#f87171',
      }}
    >
      <span style={{ fontSize: 6 }}>{on ? '●' : '●'}</span>
      {label}
    </span>
  );
}

function Btn({
  children,
  onClick,
  variant = 'default',
  disabled = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: 'default' | 'danger' | 'success';
  disabled?: boolean;
}) {
  const colors = {
    default: 'var(--accent)',
    danger: '#f87171',
    success: '#34d399',
  };
  const c = colors[variant];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="text-[11px] px-2.5 py-1 rounded font-medium transition-opacity"
      style={{
        background: `color-mix(in srgb, ${c} 18%, transparent)`,
        color: c,
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}

// ── Server Control Panel ────────────────────────────────────────────────

function ServerPanel({
  port,
  setPort,
  status,
  onRefresh,
  projectPath,
}: {
  port: string;
  setPort: (p: string) => void;
  status: StatusData | null;
  onRefresh: () => void;
  projectPath: string;
}) {
  const [busy, setBusy] = useState('');
  const [log, setLog] = useState('');
  const [actionMsg, setActionMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const action = async (act: string) => {
    setBusy(act);
    setActionMsg(null);
    try {
      const resp = await fetch(`${CRAFT}/${act}?port=${port}&projectPath=${encodeURIComponent(projectPath)}`, { method: 'POST' });
      let body: any = {};
      try { body = await resp.json(); } catch { /* empty */ }
      if (!resp.ok) {
        setActionMsg({ text: `Server error (${resp.status})`, ok: false });
      } else if (body.error) {
        setActionMsg({ text: body.error, ok: false });
      } else if (body.ok === false) {
        setActionMsg({ text: body.error || `${act} failed`, ok: false });
      } else {
        setActionMsg({ text: `${act} succeeded`, ok: true });
      }
      await new Promise((r) => setTimeout(r, 300));
      onRefresh();
    } catch (e: any) {
      setActionMsg({ text: `Network error: ${e.message}`, ok: false });
    } finally {
      setBusy('');
    }
  };

  const fetchLog = async () => {
    const r = await fetch(`${CRAFT}/log?projectPath=${encodeURIComponent(projectPath)}`);
    const d = await r.json();
    setLog(d.log || '(empty)');
  };

  return (
    <div className="rounded-lg p-3" style={{ background: 'var(--bg-secondary)' }}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">Mock Server</span>
          {status && (
            <Badge
              on={status.running}
              label={status.running ? (status.healthy ? 'Healthy' : 'Running') : 'Stopped'}
            />
          )}
          {status?.pid && (
            <span className="text-[10px] font-mono" style={{ color: 'var(--text-secondary)' }}>
              PID {status.pid}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
            Port
          </span>
          <input
            type="text"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            className="w-16 text-[11px] font-mono px-1.5 py-0.5 rounded border-0 outline-none"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
          />
        </div>
      </div>

      <div className="flex gap-1.5 flex-wrap">
        <Btn variant="success" onClick={() => action('start')} disabled={!!busy || !!status?.running}>
          {busy === 'start' ? 'Starting...' : 'Start'}
        </Btn>
        <Btn variant="danger" onClick={() => action('stop')} disabled={!!busy || !status?.running}>
          {busy === 'stop' ? 'Stopping...' : 'Stop'}
        </Btn>
        <Btn onClick={() => action('restart')} disabled={!!busy}>
          {busy === 'restart' ? 'Restarting...' : 'Restart'}
        </Btn>
        <Btn onClick={onRefresh} disabled={!!busy}>
          Refresh
        </Btn>
        <Btn onClick={fetchLog}>View Log</Btn>
      </div>

      {actionMsg && (
        <div
          className="text-[10px] px-2 py-1.5 rounded mt-1.5 whitespace-pre-wrap"
          style={{
            background: actionMsg.ok ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)',
            color: actionMsg.ok ? '#34d399' : '#f87171',
          }}
        >
          {actionMsg.text}
        </div>
      )}

      {log && (
        <pre
          className="mt-2 p-2 rounded text-[10px] font-mono overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
        >
          {log}
        </pre>
      )}
    </div>
  );
}

// ── Store List ──────────────────────────────────────────────────────────

function StoreList({
  stores,
  selected,
  onSelect,
}: {
  stores: Record<string, { recordCount: number; sizeBytes: number }>;
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  return (
    <div className="rounded-lg p-3" style={{ background: 'var(--bg-secondary)' }}>
      <h3 className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
        Data Stores (mock-data/*.json)
      </h3>
      <div className="flex flex-col gap-0.5">
        {Object.entries(stores).map(([name, info]) => (
          <button
            key={name}
            onClick={() => onSelect(name)}
            className="flex items-center justify-between px-2 py-1.5 rounded text-[11px] text-left transition-colors"
            style={{
              background: selected === name ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'transparent',
              color: selected === name ? 'var(--accent)' : 'var(--text-primary)',
            }}
          >
            <span className="font-mono">{name}.json</span>
            <span className="text-[10px] font-mono" style={{ color: 'var(--text-secondary)' }}>
              {info.recordCount >= 0 ? `${info.recordCount} records` : ''}
              {' · '}
              {info.sizeBytes < 1024
                ? `${info.sizeBytes}B`
                : `${(info.sizeBytes / 1024).toFixed(1)}KB`}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Record Editor ───────────────────────────────────────────────────────

function RecordEditor({
  name,
  port,
  serverRunning,
  projectPath,
}: {
  name: string;
  port: string;
  serverRunning: boolean;
  projectPath: string;
}) {
  const store = useForgeFetch<StoreData>(`${CRAFT}/store?name=${name}`);
  const [editJson, setEditJson] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const inject = useInject();

  useEffect(() => {
    if (store.data?.data) {
      const json = JSON.stringify(store.data.data, null, 2);
      setEditJson(json);
      setDirty(false);
      setMsg('');
    }
  }, [store.data]);

  const handleSave = async () => {
    setSaving(true);
    setMsg('');
    try {
      JSON.parse(editJson);
    } catch (e: any) {
      setMsg(`Invalid JSON: ${e.message}`);
      setSaving(false);
      return;
    }
    try {
      const r = await fetch(`${CRAFT}/store?name=${name}&projectPath=${encodeURIComponent(projectPath)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: editJson,
      });
      const d = await r.json();
      if (d.ok) {
        setMsg('Saved to disk. Restart mock-server to reload.');
        setDirty(false);
      } else {
        setMsg(`Error: ${d.error || 'save failed'}`);
      }
    } catch (e: any) {
      setMsg(`Error: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (store.data?.data) {
      setEditJson(JSON.stringify(store.data.data, null, 2));
      setDirty(false);
      setMsg('');
    }
  };

  const addRecord = () => {
    try {
      const obj = JSON.parse(editJson);
      if (Array.isArray(obj.records)) {
        const maxId = obj.records.reduce((m: number, r: any) => Math.max(m, r.id || 0), 0);
        obj.records.push({ id: maxId + 1 });
        const json = JSON.stringify(obj, null, 2);
        setEditJson(json);
        setDirty(true);
      }
    } catch { /* ignore */ }
  };

  if (store.loading) return <div style={{ color: 'var(--text-secondary)' }} className="text-xs p-3">Loading...</div>;
  if (store.error) return <div className="text-xs p-3 text-red-400">Error: {store.error}</div>;

  const recordCount = store.data?.data?.records?.length ?? 0;

  return (
    <div className="rounded-lg p-3 flex flex-col gap-2" style={{ background: 'var(--bg-secondary)' }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold font-mono" style={{ color: 'var(--accent)' }}>
            {name}.json
          </h3>
          <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
            {recordCount} records
          </span>
          {dirty && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400">
              unsaved
            </span>
          )}
        </div>
        <div className="flex gap-1.5">
          <Btn onClick={addRecord}>+ Record</Btn>
          <Btn onClick={handleReset} disabled={!dirty}>
            Reset
          </Btn>
          <Btn variant="success" onClick={handleSave} disabled={!dirty || saving}>
            {saving ? 'Saving...' : 'Save'}
          </Btn>
          <Btn onClick={() => store.refetch()}>Reload</Btn>
        </div>
      </div>

      {msg && (
        <div
          className="text-[10px] px-2 py-1 rounded"
          style={{
            background: msg.startsWith('Error') ? 'rgba(248,113,113,0.1)' : 'rgba(52,211,153,0.1)',
            color: msg.startsWith('Error') ? '#f87171' : '#34d399',
          }}
        >
          {msg}
        </div>
      )}

      <textarea
        value={editJson}
        onChange={(e) => {
          setEditJson(e.target.value);
          setDirty(true);
        }}
        spellCheck={false}
        className="w-full min-h-[300px] flex-1 p-2 rounded text-[11px] font-mono border-0 outline-none resize-y"
        style={{
          background: 'var(--bg-tertiary)',
          color: 'var(--text-primary)',
          tabSize: 2,
        }}
      />

      {serverRunning && (
        <div
          className="rounded p-2 text-[10px]"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
        >
          <span className="font-semibold">Note:</span> Edits save to disk (mock-data/{name}.json).
          The running mock-server holds data in memory — restart to pick up changes.
          Use the <span style={{ color: 'var(--accent)' }}>Live Data</span> tab below to inspect
          current in-memory state.
        </div>
      )}
    </div>
  );
}

// ── Live Data Viewer ────────────────────────────────────────────────────

const STORE_PATHS: Record<string, string> = {
  'admin-profile': '/user/admin-profile',
  host: '/host/host',
  user: '/user/user',
  'network-device': '/network-device',
  'messaging-gateway': '/settings/integration/messaging-gateway',
  'topology-container': '/topology/container',
  alarm: '/alarm',
};

function LiveDataViewer({ name, port, projectPath }: { name: string; port: string; projectPath: string }) {
  const storePath = STORE_PATHS[name];
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const fetchLive = useCallback(async () => {
    if (!storePath) return;
    setLoading(true);
    try {
      const r = await fetch(`${CRAFT}/proxy?port=${port}&path=${encodeURIComponent(storePath)}&projectPath=${encodeURIComponent(projectPath)}`);
      setData(await r.json());
    } catch (e: any) {
      setData({ error: e.message });
    } finally {
      setLoading(false);
    }
  }, [storePath, port]);

  useEffect(() => {
    fetchLive();
  }, [fetchLive]);

  if (!storePath) {
    return (
      <div className="text-[10px] p-2" style={{ color: 'var(--text-secondary)' }}>
        No live endpoint mapping for {name}
      </div>
    );
  }

  return (
    <div className="rounded-lg p-3" style={{ background: 'var(--bg-secondary)' }}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold">
          Live: <span className="font-mono" style={{ color: 'var(--accent)' }}>GET {storePath}</span>
        </h3>
        <Btn onClick={fetchLive} disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </Btn>
      </div>
      <pre
        className="p-2 rounded text-[10px] font-mono overflow-auto max-h-60 whitespace-pre-wrap"
        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
      >
        {data ? JSON.stringify(data, null, 2) : 'Loading...'}
      </pre>
    </div>
  );
}

// ── Main ────────────────────────────────────────────────────────────────

export default function MockServerTab() {
  const { projectName, projectPath } = useProject();
  const [port, setPort] = useState('18080');
  const [selectedStore, setSelectedStore] = useState<string | null>(null);
  const [showLive, setShowLive] = useState(false);

  const status = useForgeFetch<StatusData>(`${CRAFT}/status?port=${port}`);
  const storesQ = useForgeFetch<StoresData>(`${CRAFT}/stores`);

  const refreshStatus = () => status.refetch();

  const serverRunning = status.data?.running ?? false;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-auto p-4 gap-3 text-xs">
      <ServerPanel port={port} setPort={setPort} status={status.data ?? null} onRefresh={refreshStatus} projectPath={projectPath} />

      {storesQ.loading && <div style={{ color: 'var(--text-secondary)' }}>Loading stores...</div>}
      {storesQ.error && <div className="text-red-400">Error loading stores: {storesQ.error}</div>}
      {storesQ.data && (
        <StoreList
          stores={storesQ.data.stores}
          selected={selectedStore}
          onSelect={setSelectedStore}
        />
      )}

      {selectedStore && (
        <>
          <div className="flex gap-1.5">
            <Btn onClick={() => setShowLive(false)} variant={!showLive ? 'default' : 'default'}>
              Seed Data (disk)
            </Btn>
            {serverRunning && (
              <Btn onClick={() => setShowLive(true)}>
                Live Data (in-memory)
              </Btn>
            )}
          </div>

          {showLive && serverRunning ? (
            <LiveDataViewer name={selectedStore} port={port} projectPath={projectPath} />
          ) : (
            <RecordEditor name={selectedStore} port={port} serverRunning={serverRunning} projectPath={projectPath} />
          )}
        </>
      )}

      <div className="flex gap-2 mt-1">
        <Btn
          onClick={() => {
            storesQ.refetch();
            refreshStatus();
          }}
        >
          Refresh All
        </Btn>
      </div>
    </div>
  );
}
