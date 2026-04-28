import { defineCraftServer } from '@forge/craft/server';

const COMPOSE_SERVICES = ['mariadb', 'redis', 'campusmgr', 'web-server'];
const COMPOSE_DIR = 'build-tools/docker';

type ServiceState = {
  name: string;
  container: string;
  state: string;
  status: string;
  health: string;
  ports: string;
};

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
    } catch {
      // ignore non-json lines
    }
  }
  return out;
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

      // Pad with empty rows for any compose service we didn't see, so the UI
      // can render a stable grid.
      const seen = new Set(services.map((s) => s.name));
      for (const name of COMPOSE_SERVICES) {
        if (!seen.has(name)) {
          services.push({
            name,
            container: `fortinac-${name}`,
            state: '',
            status: '',
            health: '',
            ports: '',
          });
        }
      }

      // Bare-metal WAR detection — matches start-web-server.sh's pgrep.
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
  },
});
