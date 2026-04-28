import { defineCraftServer } from '@forge/craft/server';

const MOCK_DIR = 'test/mock-server';
const DATA_DIR = `${MOCK_DIR}/mock-data`;
const DEFAULT_PORT = '18080';

function getPort(query: Record<string, string>): string {
  return query.port || DEFAULT_PORT;
}

export default defineCraftServer({
  routes: {
    // ── Process control ───────────────────────────────────────────────

    'GET /status': async ({ forge, query }) => {
      const port = getPort(query);
      const r = forge.exec(`lsof -ti:${port} 2>/dev/null || true`, { timeout: 5000 });
      const pid = r.stdout.trim();
      if (!pid) return { running: false, port };
      let healthy = false;
      try {
        const h = forge.exec(`curl -sf http://localhost:${port}/health 2>/dev/null || true`, { timeout: 3000 });
        healthy = h.stdout.includes('"UP"');
      } catch { /* ignore */ }
      const logR = forge.exec('tail -8 /tmp/fortinac-mock-server.log 2>/dev/null || true', { timeout: 3000 });
      return { running: true, pid, port, healthy, log: logR.stdout.trim() };
    },

    'POST /start': async ({ forge, query }) => {
      const port = getPort(query);
      try {
        forge.exec(`cd ${MOCK_DIR} && [ -d node_modules ] || npm install`, { timeout: 30000 });
      } catch (e: any) {
        return { ok: false, error: `npm install failed: ${e.message || e}` };
      }
      const check = forge.exec(`lsof -ti:${port} 2>/dev/null || true`, { timeout: 3000 });
      if (check.stdout.trim()) {
        return { ok: false, error: `Port ${port} already in use (PID ${check.stdout.trim()})` };
      }
      try {
        forge.exec(
          `cd ${MOCK_DIR} && nohup env PORT=${port} node server.js > /tmp/fortinac-mock-server.log 2>&1 &`,
          { timeout: 5000 }
        );
      } catch (e: any) {
        return { ok: false, error: `Failed to launch: ${e.message || e}` };
      }
      forge.exec('sleep 1.5', { timeout: 4000 });
      const verify = forge.exec(`curl -sf http://localhost:${port}/health 2>/dev/null || true`, { timeout: 3000 });
      const healthy = verify.stdout.includes('"UP"');
      if (!healthy) {
        const log = forge.exec('tail -5 /tmp/fortinac-mock-server.log 2>/dev/null || true', { timeout: 2000 });
        return { ok: false, error: `Server did not become healthy. Log:\n${log.stdout.trim()}`, port };
      }
      return { ok: true, port };
    },

    'POST /stop': async ({ forge, query }) => {
      const port = getPort(query);
      const pid = forge.exec(`lsof -ti:${port} 2>/dev/null || true`, { timeout: 3000 }).stdout.trim();
      if (!pid) return { ok: true, msg: 'Nothing running on that port', port };
      try {
        forge.exec(`kill ${pid} 2>/dev/null || true`, { timeout: 3000 });
        forge.exec('sleep 0.5', { timeout: 2000 });
      } catch { /* best-effort */ }
      const check = forge.exec(`lsof -ti:${port} 2>/dev/null || true`, { timeout: 3000 });
      return { ok: !check.stdout.trim(), port };
    },

    'POST /restart': async ({ forge, query }) => {
      const port = getPort(query);
      const pid = forge.exec(`lsof -ti:${port} 2>/dev/null || true`, { timeout: 3000 }).stdout.trim();
      if (pid) {
        try {
          forge.exec(`kill ${pid} 2>/dev/null || true`, { timeout: 3000 });
          forge.exec('sleep 0.5', { timeout: 2000 });
        } catch { /* best-effort */ }
      }
      try {
        forge.exec(
          `cd ${MOCK_DIR} && nohup env PORT=${port} node server.js > /tmp/fortinac-mock-server.log 2>&1 &`,
          { timeout: 5000 }
        );
      } catch (e: any) {
        return { ok: false, error: `Failed to launch: ${e.message || e}` };
      }
      forge.exec('sleep 1.5', { timeout: 4000 });
      const verify = forge.exec(`curl -sf http://localhost:${port}/health 2>/dev/null || true`, { timeout: 3000 });
      return { ok: verify.stdout.includes('"UP"'), port };
    },

    'GET /log': async ({ forge }) => {
      const r = forge.exec('tail -30 /tmp/fortinac-mock-server.log 2>/dev/null || echo "(no log file)"', { timeout: 3000 });
      return { log: r.stdout };
    },

    // ── Data store management ─────────────────────────────────────────

    'GET /stores': async ({ forge }) => {
      const r = forge.exec(`ls ${DATA_DIR}/*.json 2>/dev/null | xargs -I{} basename {} .json`, { timeout: 3000 });
      const names = r.stdout.split('\n').filter(Boolean);
      const stores: Record<string, { recordCount: number; sizeBytes: number }> = {};
      for (const name of names) {
        const file = `${DATA_DIR}/${name}.json`;
        const content = forge.exec(`cat ${file}`, { timeout: 3000 });
        const sizeR = forge.exec(`wc -c < ${file}`, { timeout: 3000 });
        try {
          const parsed = JSON.parse(content.stdout);
          stores[name] = {
            recordCount: Array.isArray(parsed.records) ? parsed.records.length : -1,
            sizeBytes: parseInt(sizeR.stdout.trim(), 10) || 0,
          };
        } catch {
          stores[name] = { recordCount: -1, sizeBytes: 0 };
        }
      }
      return { stores };
    },

    'GET /store': async ({ forge, query }) => {
      const name = query.name;
      if (!name) return { error: 'Missing ?name=' };
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
      const file = `${DATA_DIR}/${safeName}.json`;
      const r = forge.exec(`cat ${file} 2>/dev/null || echo "null"`, { timeout: 5000 });
      try {
        const data = JSON.parse(r.stdout);
        return { name: safeName, data };
      } catch {
        return { error: `Failed to parse ${safeName}.json` };
      }
    },

    'POST /store': async ({ forge, query, body }) => {
      const name = query.name;
      if (!name) return { error: 'Missing ?name=' };
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
      const file = `${DATA_DIR}/${safeName}.json`;
      const exists = forge.exec(`test -f ${file} && echo yes || echo no`, { timeout: 2000 });
      if (exists.stdout.trim() !== 'yes') return { error: `Store ${safeName} not found` };
      const json = JSON.stringify(body, null, 2);
      forge.exec(`cat > ${file}`, { timeout: 5000, stdin: json });
      return { ok: true, name: safeName };
    },

    // ── Live data proxy (talk to running mock-server) ─────────────────

    'GET /proxy': async ({ forge, query }) => {
      const port = getPort(query);
      const storePath = query.path || '';
      if (!storePath) return { error: 'Missing ?path=' };
      const r = forge.exec(
        `curl -sf "http://localhost:${port}${storePath}" 2>/dev/null || echo '{"status":"error","errorMessage":"Mock server unreachable"}'`,
        { timeout: 5000 }
      );
      try {
        return JSON.parse(r.stdout);
      } catch {
        return { error: 'Invalid response from mock-server' };
      }
    },

    'POST /proxy': async ({ forge, query, body }) => {
      const port = getPort(query);
      const storePath = query.path || '';
      if (!storePath) return { error: 'Missing ?path=' };
      const json = JSON.stringify(body || {});
      const r = forge.exec(
        `curl -sf -X POST -H "Content-Type: application/json" -d '${json.replace(/'/g, "'\\''")}' "http://localhost:${port}${storePath}" 2>/dev/null || echo '{"status":"error","errorMessage":"Mock server unreachable"}'`,
        { timeout: 5000 }
      );
      try {
        return JSON.parse(r.stdout);
      } catch {
        return { error: 'Invalid response from mock-server' };
      }
    },
  },
});
