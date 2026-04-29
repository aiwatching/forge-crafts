// Migration craft — server side. All routes are mounted at
// /api/crafts/migration/<route>. Storage uses craft-scoped data/.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { defineCraftServer } from '@forge/craft/server';
import type { Annotation, Endpoint, Failure, FailureCluster, MigrationConfig, RunResult } from './_types';
import { DEFAULT_CONFIG } from './_types';
import { discoverEndpoints, resolveJavaPathsForEndpoint } from './_discoverer';
import { runEndpoint, runEndpoints } from './_runner';
import { buildOpenApiDoc, type OpenApiDoc } from './_openapi';
import { makeContext, renderDiagnosisMarkdown, renderBatchDiagnosis } from './_diagnose';

// ── Storage helpers ────────────────────────────────────
// forge.storage uses safe filenames (alphanumeric + . + - + _). Timestamps
// have ":" so we sanitize when writing run files.

function loadConfig(forge: any): MigrationConfig {
  const stored = forge.storage.read<Partial<MigrationConfig>>('config.json');
  if (!stored) return structuredClone(DEFAULT_CONFIG);
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    auth: { ...DEFAULT_CONFIG.auth, ...(stored.auth || {}) },
    healthCheck: { ...DEFAULT_CONFIG.healthCheck, ...(stored.healthCheck || {}) },
    endpointSource: { ...DEFAULT_CONFIG.endpointSource, ...(stored.endpointSource || {}) },
    pathSubstitutions: { ...DEFAULT_CONFIG.pathSubstitutions, ...(stored.pathSubstitutions || {}) },
  } as MigrationConfig;
}

function loadEndpoints(forge: any): Endpoint[] {
  return forge.storage.read<Endpoint[]>('endpoints.json') || [];
}

function loadAnnotations(forge: any): Record<string, Annotation> {
  return forge.storage.read<Record<string, Annotation>>('annotations.json') || {};
}

function saveRun(forge: any, results: RunResult[]): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `run-${ts}.json`;
  forge.storage.write(file, results);
  return file;
}

function listRunFiles(forge: any): string[] {
  return forge.storage.listFiles().filter((f: string) => f.startsWith('run-') && f.endsWith('.json'));
}

function loadRun(forge: any, file: string): RunResult[] {
  return forge.storage.read<RunResult[]>(file) || [];
}

function findLatestResultForEndpoint(forge: any, endpointId: string): RunResult | undefined {
  const runs = listRunFiles(forge).sort().reverse();   // ISO-like names sort lexicographically
  for (const f of runs) {
    const list = loadRun(forge, f);
    const found = list.find(r => r.endpointId === endpointId);
    if (found) return found;
  }
  return undefined;
}

function loadOpenApi(forge: any, config: MigrationConfig): OpenApiDoc | null {
  if (!config.endpointSource.openApiSpec) return null;
  const raw = forge.openapi(config.endpointSource.openApiSpec);
  if (!raw) return null;
  return buildOpenApiDoc(raw);
}

function clusterFailures(failures: Failure[]): FailureCluster[] {
  const byType = new Map<string, Map<string, Failure[]>>();
  for (const f of failures) {
    let m = byType.get(f.errorType);
    if (!m) { m = new Map(); byType.set(f.errorType, m); }
    let arr = m.get(f.controller);
    if (!arr) { arr = []; m.set(f.controller, arr); }
    arr.push(f);
  }
  const out: FailureCluster[] = [];
  for (const [errorType, ctrlMap] of byType) {
    const controllers = [...ctrlMap.entries()].map(([controller, failures]) => ({ controller, failures }));
    controllers.sort((a, b) => b.failures.length - a.failures.length);
    out.push({
      errorType,
      count: controllers.reduce((s, c) => s + c.failures.length, 0),
      controllers,
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

function findBoundSession(projectPath: string): string | null {
  try {
    const sessions = execSync(`tmux list-sessions -F '#{session_name}'`, { encoding: 'utf8', timeout: 2000 })
      .trim().split('\n').filter(Boolean).filter(n => /^mw[a-z0-9]*-/.test(n));
    for (const s of sessions) {
      try {
        const cwd = execSync(`tmux display-message -p -t '${s}' '#{pane_current_path}'`, { encoding: 'utf8', timeout: 2000 }).trim();
        if (cwd === projectPath || cwd.startsWith(projectPath + '/')) return s;
      } catch {}
    }
  } catch {}
  return null;
}

// ── Routes ─────────────────────────────────────────────

export default defineCraftServer({
  routes: {
    // Config
    'GET /config': async ({ forge }) => loadConfig(forge),
    'POST /config': async ({ body, forge }) => {
      forge.storage.write('config.json', body.config);
      return { ok: true };
    },

    // Discovery (cached + on-demand)
    'GET /discover': async ({ projectPath, forge }) => {
      const cached = loadEndpoints(forge);
      const stale = cached.length > 0 && !cached.some(e => e.legacyJavaPath || e.newJavaPath);
      if (!stale) return { endpoints: cached };
      const config = loadConfig(forge);
      const raw = config.endpointSource.openApiSpec ? forge.openapi(config.endpointSource.openApiSpec) : null;
      const result = discoverEndpoints(projectPath, config, raw);
      forge.storage.write('endpoints.json', result.endpoints);
      return { endpoints: result.endpoints };
    },
    // Re-resolve legacy/new Java paths for one endpoint (per-row 🔍 button).
    'POST /resolve-java': async ({ projectPath, body, forge }) => {
      const endpoints = loadEndpoints(forge);
      const ep = endpoints.find(e => e.id === body.endpointId);
      if (!ep) return { ok: false, error: 'endpoint not found' };
      const { legacyJavaPath, newJavaPath } = resolveJavaPathsForEndpoint(projectPath, ep);
      ep.legacyJavaPath = legacyJavaPath;
      ep.newJavaPath = newJavaPath;
      forge.storage.write('endpoints.json', endpoints);
      return { ok: true, legacyJavaPath, newJavaPath };
    },

    // Re-resolve Java paths for ALL endpoints in a single pass (one index build).
    'POST /resolve-java-all': async ({ projectPath, forge }) => {
      const endpoints = loadEndpoints(forge);
      let lj = 0, nj = 0;
      // Build indexes once by calling per-endpoint resolver — but that rebuilds N times.
      // Cheap path: call discoverEndpoints fresh, merge legacyJavaPath/newJavaPath by id.
      const config = loadConfig(forge);
      const raw = config.endpointSource.openApiSpec ? forge.openapi(config.endpointSource.openApiSpec) : null;
      const fresh = discoverEndpoints(projectPath, config, raw);
      const byId = new Map(fresh.endpoints.map(e => [e.id, e]));
      for (const ep of endpoints) {
        const f = byId.get(ep.id);
        if (f) {
          ep.legacyJavaPath = f.legacyJavaPath;
          ep.newJavaPath = f.newJavaPath;
          if (ep.legacyJavaPath) lj++;
          if (ep.newJavaPath) nj++;
        }
      }
      forge.storage.write('endpoints.json', endpoints);
      return { ok: true, total: endpoints.length, withLegacyJava: lj, withNewJava: nj };
    },

    'POST /discover': async ({ projectPath, forge }) => {
      const config = loadConfig(forge);
      const raw = config.endpointSource.openApiSpec ? forge.openapi(config.endpointSource.openApiSpec) : null;
      const result = discoverEndpoints(projectPath, config, raw);
      forge.storage.write('endpoints.json', result.endpoints);
      return {
        endpoints: result.endpoints,
        warnings: result.warnings,
        sources: result.sources,
        total: result.endpoints.length,
        stats: result.stats,
      };
    },

    // Single run
    'POST /run': async ({ projectPath, body, forge }) => {
      const eps = loadEndpoints(forge);
      const ep = eps.find(e => e.id === body.endpointId);
      if (!ep) return new Response(JSON.stringify({ error: 'endpoint not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      const config = loadConfig(forge);
      const openApi = loadOpenApi(forge, config);
      const annotations = loadAnnotations(forge);
      const result = await runEndpoint(ep, config, openApi, annotations[body.endpointId] || null);
      saveRun(forge, [result]);
      return result;
    },

    // Batch run with SSE progress
    'POST /run-batch': async ({ projectPath, body, forge }) => {
      const config = loadConfig(forge);
      const all = loadEndpoints(forge);
      const annotations = loadAnnotations(forge);
      const openApi = loadOpenApi(forge, config);

      let toRun = all;
      if (body.endpointIds && body.endpointIds.length > 0) {
        const ids = new Set(body.endpointIds);
        toRun = all.filter(e => ids.has(e.id));
      } else if (body.onlyStatus && body.onlyStatus.length > 0) {
        const s = new Set(body.onlyStatus);
        toRun = all.filter(e => s.has(e.status));
      }

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (event: string, data: any) => {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };
          send('start', { total: toRun.length });
          try {
            const results = await runEndpoints(toRun, config, {
              concurrency: body.concurrency ?? 4,
              openApi, annotations,
              onProgress: (done, total, last) => send('progress', { done, total, result: last }),
            });
            saveRun(forge, results);

            const failures: Failure[] = results
              .filter(r => r.match === 'fail' || r.match === 'error')
              .map(r => {
                const ep = toRun.find(e => e.id === r.endpointId)!;
                return {
                  endpointId: r.endpointId,
                  controller: ep.controller,
                  method: ep.method,
                  path: ep.path,
                  errorType: r.errorType || 'unknown',
                  errorMessage: r.errorMessage || '',
                  lastSeenAt: r.startedAt,
                };
              });
            forge.storage.write('failures.json', failures);

            send('done', {
              total: results.length,
              pass: results.filter(r => r.match === 'pass').length,
              fail: results.filter(r => r.match === 'fail').length,
              stubOk: results.filter(r => r.match === 'stub-ok').length,
              flagged: results.filter(r => r.match === 'flagged').length,
              error: results.filter(r => r.match === 'error').length,
              failures: failures.length,
            });
          } catch (e: any) {
            send('error', { message: e?.message || String(e) });
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
      });
    },

    // Failures
    'GET /failures': async ({ forge }) => {
      const failures = forge.storage.read<Failure[]>('failures.json') || [];
      return { failures, clusters: clusterFailures(failures) };
    },

    // Diagnose (build context + markdown)
    'GET /diagnose': async ({ projectPath, query, forge }) => {
      const eps = loadEndpoints(forge);
      const ep = eps.find(e => e.id === query.endpointId);
      if (!ep) return new Response(JSON.stringify({ error: 'endpoint not found' }), { status: 404 });
      const config = loadConfig(forge);
      const openApi = loadOpenApi(forge, config);
      const annotation = loadAnnotations(forge)[query.endpointId] || null;
      const result = findLatestResultForEndpoint(forge, query.endpointId);

      let docContent: string | undefined;
      let docPath: string | undefined;
      if (ep.docFile) {
        docPath = `${config.endpointSource.primary}/${ep.docFile}`;
        const full = join(projectPath, docPath);
        if (existsSync(full)) {
          const c = readFileSync(full, 'utf8');
          docContent = c.length > 8192 ? c.slice(0, 8192) + '\n\n…(truncated)' : c;
        }
      }

      const ctx = makeContext({ endpoint: ep, result, openApi, annotation, docContent, docPath, config });
      return { context: ctx, markdown: renderDiagnosisMarkdown(ctx) };
    },

    // Spawn task / inject with diagnosis prompt (single or batch)
    'POST /diagnose': async ({ projectPath, body, forge }) => {
      const eps = loadEndpoints(forge);
      const ids: string[] = body.endpointIds || [];
      if (ids.length === 0) return new Response(JSON.stringify({ error: 'endpointIds required' }), { status: 400 });

      const config = loadConfig(forge);
      const openApi = loadOpenApi(forge, config);
      const annotations = loadAnnotations(forge);

      const ctxs = ids.map(id => {
        const ep = eps.find(e => e.id === id);
        if (!ep) return null;
        const result = findLatestResultForEndpoint(forge, id);
        let docContent: string | undefined;
        let docPath: string | undefined;
        if (ep.docFile) {
          docPath = `${config.endpointSource.primary}/${ep.docFile}`;
          const full = join(projectPath, docPath);
          if (existsSync(full)) {
            const c = readFileSync(full, 'utf8');
            docContent = c.length > 8192 ? c.slice(0, 8192) + '\n\n…(truncated)' : c;
          }
        }
        return makeContext({ endpoint: ep, result, openApi, annotation: annotations[id] || null, docContent, docPath, config });
      }).filter((x): x is NonNullable<typeof x> => !!x);

      if (ctxs.length === 0) return new Response(JSON.stringify({ error: 'no endpoints found' }), { status: 404 });

      let prompt: string;
      if (body.promptOverride && body.promptOverride.trim()) {
        // User edited the markdown in the drawer — use verbatim, skip auto-render
        prompt = body.promptOverride;
      } else {
        prompt = ctxs.length === 1 ? renderDiagnosisMarkdown(ctxs[0]) : renderBatchDiagnosis(ctxs);
      }
      if (body.customPrompt) prompt += '\n\n## Additional context from user\n\n' + body.customPrompt;

      if (body.mode === 'preview') return { prompt, count: ctxs.length };

      if (body.mode === 'inject') {
        const sessionName = body.sessionName || findBoundSession(projectPath);
        if (!sessionName) return new Response(JSON.stringify({ error: 'no session resolved' }), { status: 400 });
        const r = forge.inject(prompt, { sessionName });
        return { ok: !!r.ok, mode: 'inject', sessionName: r.sessionName, count: ctxs.length };
      }

      // Default: task
      const t = forge.task({ prompt });
      return { ok: true, mode: 'task', taskId: t.id, count: ctxs.length };
    },

    // Annotations CRUD
    'GET /annotations': async ({ forge }) => loadAnnotations(forge),
    'POST /annotations': async ({ body, forge }) => {
      const all = loadAnnotations(forge);
      const ann: Annotation = { ...body.annotation, flaggedAt: body.annotation.flaggedAt || new Date().toISOString() };
      all[ann.endpointId] = ann;
      forge.storage.write('annotations.json', all);
      return { ok: true };
    },
    'DELETE /annotations/:endpointId': async ({ params, forge }) => {
      const all = loadAnnotations(forge);
      if (all[params.endpointId]) {
        delete all[params.endpointId];
        forge.storage.write('annotations.json', all);
      }
      return { ok: true };
    },

    // Resolve project's bound terminal sessions (for inject)
    'GET /sessions': async ({ projectPath }) => {
      try {
        const sessions = execSync(`tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_attached}'`, { encoding: 'utf8', timeout: 2000 })
          .trim().split('\n').filter(Boolean).map(line => {
            const [name, w, att] = line.split('|');
            return { name, windows: Number(w) || 1, attached: att === '1' };
          }).filter(s => /^mw[a-z0-9]*-/.test(s.name));
        const matches: { name: string; cwd: string; attached: boolean }[] = [];
        const others: { name: string; cwd: string; attached: boolean }[] = [];
        for (const s of sessions) {
          try {
            const cwd = execSync(`tmux display-message -p -t '${s.name}' '#{pane_current_path}'`, { encoding: 'utf8', timeout: 2000 }).trim();
            const info = { name: s.name, cwd, attached: s.attached };
            if (cwd === projectPath || cwd.startsWith(projectPath + '/')) matches.push(info);
            else others.push(info);
          } catch {}
        }
        return { matches, others };
      } catch {
        return { matches: [], others: [] };
      }
    },
  },
});
