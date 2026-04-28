import { defineCraftServer } from '@forge/craft/server';

const COMPOSE_SERVICES = new Set(['mariadb', 'redis', 'campusmgr', 'web-server']);
const COMPOSE_DIR = 'build-tools/docker';
const WS_SCRIPT = 'build-tools/scripts/start-web-server.sh';

type ServiceState = {
  name: string;
  container: string;
  state: string;
  status: string;
  health: string;
  ports: string;
};

function safeService(s: any): string | undefined {
  if (typeof s !== 'string' || !s) return undefined;
  return COMPOSE_SERVICES.has(s) ? s : undefined;
}

function parseComposePs(stdout: string): ServiceState[] {
  const out: ServiceState[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const j = JSON.parse(line);
      out.push({
        name: j.Service || j.Name || '',
        container: j.Name || '',
        state: j.State || '',
        status: j.Status || '',
        health: j.Health || '',
        ports: j.Publishers
          ? j.Publishers
              .filter((p: any) => p.PublishedPort)
              .map((p: any) => `${p.PublishedPort}:${p.TargetPort}`)
              .join(', ')
          : j.Ports || '',
      });
    } catch { /* ignore non-json lines */ }
  }
  return out;
}

function detached(forge: any, cmd: string, logFile: string) {
  // Wrap in `nohup … &` so the command keeps running after exec returns.
  // setsid + disown so it's fully detached from any session.
  const wrapped = `: > ${logFile}; nohup bash -c ${shellQuote(cmd)} >> ${logFile} 2>&1 < /dev/null & disown`;
  forge.exec(wrapped, { timeout: 3000 });
  return logFile;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export default defineCraftServer({
  routes: {
    'GET /status': async ({ forge }) => {
      let services: ServiceState[] = [];
      let error: string | undefined;
      const ps = forge.exec(
        `cd ${COMPOSE_DIR} && docker compose ps --all --format json`,
        { timeout: 8000 },
      );
      if (ps.code === 0) {
        services = parseComposePs(ps.stdout);
      } else {
        error = (ps.stderr || ps.stdout || '').trim().slice(0, 400);
      }
      const seen = new Set(services.map((s) => s.name));
      for (const name of COMPOSE_SERVICES) {
        if (!seen.has(name)) {
          services.push({ name, container: `fortinac-${name}`, state: '', status: '', health: '', ports: '' });
        }
      }
      const war = forge.exec(
        `pgrep -f 'java .*web-server-7\\.6\\.0\\.war' 2>/dev/null || true`,
        { timeout: 3000 },
      );
      const warPid = (war.stdout || '').trim().split('\n').filter(Boolean).join(',');
      return {
        ok: !error,
        services,
        warServerRunning: warPid.length > 0,
        warServerPid: warPid,
        composeFile: 'build-tools/docker/docker-compose.yml',
        error,
      };
    },

    // ── Compose actions ─────────────────────────────────────────────────

    'POST /up': async ({ forge, body }) => {
      const svc = safeService(body?.service);
      if (svc) {
        // Quick: target one service, block.
        const r = forge.exec(
          `cd ${COMPOSE_DIR} && docker compose up -d ${svc} 2>&1`,
          { timeout: 60000 },
        );
        return r.code === 0
          ? { ok: true, output: r.stdout.slice(-4000) }
          : { ok: false, error: (r.stdout || r.stderr).slice(-2000) };
      }
      // Whole stack — detach (mariadb init + image pulls can take a while).
      const log = '/tmp/fortinac-craft-up.log';
      detached(forge, `cd ${COMPOSE_DIR} && docker compose up -d`, log);
      return { ok: true, detached: true, logFile: log };
    },

    'POST /down': async ({ forge }) => {
      const r = forge.exec(`cd ${COMPOSE_DIR} && docker compose down 2>&1`, { timeout: 45000 });
      return r.code === 0
        ? { ok: true, output: r.stdout.slice(-4000) }
        : { ok: false, error: (r.stdout || r.stderr).slice(-2000) };
    },

    'POST /restart': async ({ forge, body }) => {
      const svc = safeService(body?.service);
      if (!svc) return { ok: false, error: 'restart requires a service name' };
      const r = forge.exec(`cd ${COMPOSE_DIR} && docker compose restart ${svc} 2>&1`, { timeout: 30000 });
      return r.code === 0
        ? { ok: true, output: r.stdout.slice(-4000) }
        : { ok: false, error: (r.stdout || r.stderr).slice(-2000) };
    },

    'POST /stop': async ({ forge, body }) => {
      const svc = safeService(body?.service);
      if (!svc) return { ok: false, error: 'stop requires a service name' };
      const r = forge.exec(`cd ${COMPOSE_DIR} && docker compose stop ${svc} 2>&1`, { timeout: 20000 });
      return r.code === 0
        ? { ok: true, output: r.stdout.slice(-4000) }
        : { ok: false, error: (r.stdout || r.stderr).slice(-2000) };
    },

    'POST /rebuild': async ({ forge, body }) => {
      const svc = safeService(body?.service);
      const target = svc ? svc : '';
      const log = svc ? `/tmp/fortinac-craft-rebuild-${svc}.log` : '/tmp/fortinac-craft-rebuild.log';
      detached(
        forge,
        `cd ${COMPOSE_DIR} && docker compose up -d --build --force-recreate ${target}`.trim(),
        log,
      );
      return { ok: true, detached: true, logFile: log };
    },

    'POST /follow-logs': async ({ forge, body }) => {
      const svc = safeService(body?.service);
      const target = svc ? svc : '';
      const log = svc ? `/tmp/fortinac-craft-logs-${svc}.log` : '/tmp/fortinac-craft-logs.log';
      // Kill any prior `compose logs -f` for this craft to avoid log accumulation.
      forge.exec(
        `pkill -f 'docker compose .* logs -f.*fortinac-craft' 2>/dev/null || true`,
        { timeout: 2000 },
      );
      detached(forge, `cd ${COMPOSE_DIR} && docker compose logs -f --tail=200 ${target}`.trim(), log);
      return { ok: true, detached: true, logFile: log };
    },

    // ── Bare-metal web-server ───────────────────────────────────────────

    'POST /ws-start': async ({ forge, body }) => {
      const build = !!body?.build;
      const log = '/tmp/fortinac-craft-ws-start.log';
      // The script itself daemonises with `-d`, but if we also build the
      // mvn phase blocks for ~minute+. Always detach the wrapper so the
      // route returns immediately.
      const flags = build ? '-d --build' : '-d';
      detached(forge, `${WS_SCRIPT} ${flags}`, log);
      return { ok: true, detached: true, logFile: log };
    },

    'POST /ws-stop': async ({ forge }) => {
      const r = forge.exec(`${WS_SCRIPT} stop 2>&1`, { timeout: 15000 });
      return { ok: r.code === 0, output: r.stdout.slice(-2000), error: r.code === 0 ? undefined : (r.stderr || r.stdout).slice(-2000) };
    },

    // ── Log viewer ──────────────────────────────────────────────────────

    'GET /log': async ({ forge, query }) => {
      const file = query.file || '';
      // Allowlist: only files we created, plus the bare-metal script's log.
      const allowed = new Set([
        '/tmp/fortinac-web-server.log',
        '/tmp/fortinac-craft-up.log',
        '/tmp/fortinac-craft-rebuild.log',
        '/tmp/fortinac-craft-logs.log',
        '/tmp/fortinac-craft-ws-start.log',
      ]);
      const isPerSvc = /^\/tmp\/fortinac-craft-(rebuild|logs)-[a-z-]+\.log$/.test(file);
      if (!allowed.has(file) && !isPerSvc) {
        return { log: `(refused: ${file} not in allowlist)` };
      }
      const r = forge.exec(`tail -200 ${file} 2>/dev/null || echo '(no log file yet)'`, { timeout: 3000 });
      return { log: r.stdout };
    },
  },
});
