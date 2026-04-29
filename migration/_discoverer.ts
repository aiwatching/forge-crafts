// Endpoint discovery — OpenAPI primary + per-controller markdown annotation
// + migration-history.md fallback. Ported from forge/lib/migration/discoverer.ts.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Endpoint, EndpointStatus, HttpMethod, MigrationConfig } from './_types';
import { buildOpenApiDoc, getResponseSchema, type OpenApiDoc } from './_openapi';

function endpointId(method: string, path: string): string {
  return createHash('sha1').update(`${method.toUpperCase()} ${path}`).digest('hex').slice(0, 12);
}

const METHOD_PATH_RE = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b\s+(\/[^\s`|<>]+)/i;
const PATH_ANNOTATION_RE = /@Path\(\s*"([^"]+)"\s*\)/;

type SectionKind = 'migrated' | 'stubbed' | 'parity-only' | 'unknown';

function classifyHeading(line: string): SectionKind | null {
  const lower = line.toLowerCase();
  if (lower.includes('url parity') || lower.includes('url-parity')) return 'parity-only';
  if (lower.includes('stub') || lower.includes('🚫') || lower.includes('501') || lower.includes('not implemented')) return 'stubbed';
  if (lower.includes('migrated') || lower.includes('✅') || lower.includes('implemented')) return 'migrated';
  return null;
}

function expandPath(rawPath: string, prefix: string | undefined): string | null {
  if (/^\/?\.\.\.?$/.test(rawPath)) return null;
  if (rawPath.startsWith('/...')) {
    if (!prefix) return null;
    return prefix.replace(/\/$/, '') + rawPath.slice(4);
  }
  if (rawPath.startsWith('.../')) {
    if (!prefix) return null;
    return prefix.replace(/\/$/, '') + '/' + rawPath.slice(4);
  }
  return rawPath;
}

interface DocAnnotation {
  kind: SectionKind;
  controller: string;
  file: string;
  notes?: string;
  legacyJavaPath?: string;
  newJavaPath?: string;
}

const SOURCE_LINE_RE = /^>\s*Source:\s*`([^`]+\.java)`/m;
const TARGET_LINE_RE = /^>\s*Target:\s*`([^`]+\.java)`/m;

const LEGACY_JAVA_ROOTS = ['masterloader/service/src/main/java'];
const NEW_JAVA_ROOTS = ['fnac-access/web-server/src/main/java'];

interface UrlIndex {
  exact: Map<string, string>;          // "GET /a/b" -> relPath
  patterns: { re: RegExp; file: string }[]; // for {id} placeholders
}

const HTTP_VERBS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

function urlPatternToRegex(pattern: string): RegExp {
  // Replace {id}, {name:regex}, :id with .+; escape regex chars otherwise
  const escaped = pattern
    .replace(/\{[^}]+\}/g, '___PH___')
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '___PH___')
    .replace(/[.+*?^$()|[\]\\]/g, '\\$&')
    .replace(/___PH___/g, '[^/]+');
  return new RegExp(`^[A-Z]+ ${escaped}$`);
}

function joinUrl(prefix: string, suffix: string): string {
  if (!suffix) return prefix || '/';
  if (!prefix) return suffix.startsWith('/') ? suffix : `/${suffix}`;
  const a = prefix.replace(/\/$/, '');
  const b = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `${a}${b}` || '/';
}

function extractAnnotationValue(anno: string, attr?: string): string | undefined {
  // @Path("/x"), @RequestMapping("/x"), @GetMapping("/x"),
  // @RequestMapping(value = "/x", method = ...), @PostMapping(path = "/x")
  if (!attr) {
    const m = anno.match(/^\s*\(\s*"([^"]*)"\s*\)/) || anno.match(/^\s*\(\s*\{?\s*"([^"]*)"/);
    if (m) return m[1];
  }
  const re = new RegExp(`${attr || 'value'}\\s*=\\s*"([^"]*)"`);
  const m = anno.match(re);
  return m?.[1];
}

function buildUrlIndex(projectPath: string, roots: string[]): UrlIndex {
  const index: UrlIndex = { exact: new Map(), patterns: [] };
  for (const rel of roots) {
    const root = join(projectPath, rel);
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: string[] = [];
      try { entries = readdirSync(dir); } catch { continue; }
      for (const entry of entries) {
        const full = join(dir, entry);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) { stack.push(full); continue; }
        if (!entry.endsWith('.java')) continue;
        let src = '';
        try { src = readFileSync(full, 'utf8'); } catch { continue; }
        if (!/@(Path|RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|GET|POST|PUT|DELETE|PATCH)\b/.test(src)) continue;

        const fileRel = full.slice(projectPath.length + 1);
        // Class-level prefix
        const classBlock = src.split(/\bclass\s+\w+/)[0] || '';
        const classPath =
          extractAnnotationValue(classBlock.match(/@RequestMapping([\s\S]*?\))/)?.[1] || '') ||
          extractAnnotationValue(classBlock.match(/@Path([\s\S]*?\))/)?.[1] || '') || '';

        // Method-level routes
        const lines = src.split('\n');
        let pendingPath: string | undefined;
        let pendingVerb: string | undefined;
        let inClassBody = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!inClassBody) {
            if (/\bclass\s+\w+/.test(line)) inClassBody = true;
            continue;
          }
          // JAX-RS style: @GET / @POST / ... preceding @Path
          const verbM = line.match(/@(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/);
          if (verbM) pendingVerb = verbM[1];
          const pathM = line.match(/@Path\(\s*"([^"]*)"\s*\)/);
          if (pathM) pendingPath = pathM[1];

          // Spring style: @GetMapping("/x"), @RequestMapping(value="/x", method=GET)
          const sm = line.match(/@(Get|Post|Put|Delete|Patch)Mapping\b([\s\S]*?\))/);
          if (sm) {
            const verb = sm[1].toUpperCase();
            const val = extractAnnotationValue(sm[2]) || extractAnnotationValue(sm[2], 'path') || '';
            const fullPath = joinUrl(classPath, val);
            recordRoute(index, verb, fullPath, fileRel);
          }
          const rm = line.match(/@RequestMapping\b([\s\S]*?\))/);
          if (rm) {
            const args = rm[1];
            const val = extractAnnotationValue(args) || extractAnnotationValue(args, 'path') || '';
            const methods = [...args.matchAll(/RequestMethod\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)/g)].map(m => m[1]);
            const fullPath = joinUrl(classPath, val);
            if (methods.length === 0) {
              for (const v of HTTP_VERBS) recordRoute(index, v, fullPath, fileRel);
            } else {
              for (const v of methods) recordRoute(index, v, fullPath, fileRel);
            }
          }
          // JAX-RS: when method declaration appears, flush pending verb+path
          if (/^\s*(public|private|protected)\b/.test(line) && pendingVerb) {
            const fullPath = joinUrl(classPath, pendingPath || '');
            recordRoute(index, pendingVerb, fullPath, fileRel);
            pendingVerb = undefined;
            pendingPath = undefined;
          }
        }
      }
    }
  }
  return index;
}

function recordRoute(index: UrlIndex, verb: string, path: string, file: string) {
  const key = `${verb} ${path}`;
  if (!index.exact.has(key)) index.exact.set(key, file);
  if (path.includes('{') || path.includes(':')) {
    index.patterns.push({ re: urlPatternToRegex(path), file });
  }
}

function buildJavaFileIndex(projectPath: string, roots: string[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const rel of roots) {
    const root = join(projectPath, rel);
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: string[] = [];
      try { entries = readdirSync(dir); } catch { continue; }
      for (const entry of entries) {
        const full = join(dir, entry);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) stack.push(full);
        else if (entry.endsWith('.java')) {
          const relPath = full.slice(projectPath.length + 1);
          if (!idx.has(entry)) idx.set(entry, relPath);
        }
      }
    }
  }
  return idx;
}

function parsePerControllerDocs(projectPath: string, dirRel: string): {
  byKey: Map<string, DocAnnotation>;
  warnings: string[];
} {
  const byKey = new Map<string, DocAnnotation>();
  const warnings: string[] = [];
  const dir = join(projectPath, dirRel);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    warnings.push(`Per-controller docs dir not found: ${dir}`);
    return { byKey, warnings };
  }

  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') || f.startsWith('_')) continue;
    const filePath = join(dir, f);
    const content = readFileSync(filePath, 'utf8');

    const titleMatch = content.match(/^#\s+([A-Za-z0-9_$]+)(?:\.java)?\b/m);
    const controller = titleMatch?.[1] || f.replace(/\.java\.md$/i, '');
    const pathAnno = content.match(PATH_ANNOTATION_RE)?.[1];

    const docLegacy = content.match(SOURCE_LINE_RE)?.[1];
    const targetRaw = content.match(TARGET_LINE_RE)?.[1];
    const docNew = targetRaw && !targetRaw.includes('...') ? targetRaw : undefined;
    const baseAnno = { legacyJavaPath: docLegacy, newJavaPath: docNew };

    let currentKind: SectionKind = 'unknown';
    let inTable = false;
    let count = 0;

    for (const raw of content.split('\n')) {
      const line = raw.trimEnd();
      if (/^#{2,6}\s/.test(line)) {
        const k = classifyHeading(line);
        if (k) currentKind = k;
        else {
          const lower = line.toLowerCase();
          if (lower.includes('what it does') || lower.includes('files added') || lower.includes('changelog')) {
            currentKind = 'unknown';
          }
        }
        inTable = false;
        continue;
      }
      if (currentKind === 'unknown' && /url[- ]parity[- ]only/i.test(line)) currentKind = 'parity-only';

      if (line.startsWith('|')) {
        const cells = line.split('|').slice(1, -1).map(c => c.trim());
        if (cells.length === 0) continue;
        if (cells.every(c => /^:?-+:?$/.test(c))) continue;
        if (!inTable) {
          const lower = cells.map(c => c.toLowerCase()).join(' | ');
          if (/\bhttp\b|\bpath\b|\bmethod\b|\bendpoint\b|\bverb\b/.test(lower)) {
            inTable = true; continue;
          }
        }
        const m = line.match(METHOD_PATH_RE);
        if (m) {
          const expanded = expandPath(m[2].trim(), pathAnno);
          if (expanded) {
            const key = `${m[1].toUpperCase()} ${expanded}`;
            const notes = cells.slice(1).join(' | ').replace(/`/g, '').trim() || undefined;
            byKey.set(key, { kind: currentKind === 'unknown' ? 'migrated' : currentKind, controller, file: f, notes, ...baseAnno });
            count++;
          }
        }
        continue;
      }

      if (line.startsWith('-') || line.startsWith('*')) {
        const m = line.match(METHOD_PATH_RE);
        if (m) {
          const expanded = expandPath(m[2].trim(), pathAnno);
          if (expanded) {
            const key = `${m[1].toUpperCase()} ${expanded}`;
            byKey.set(key, { kind: currentKind === 'unknown' ? 'migrated' : currentKind, controller, file: f, ...baseAnno });
            count++;
          }
        }
      }
      if (line.trim() === '') inTable = false;
    }

    if (count === 0 && pathAnno) {
      byKey.set(`__PREFIX__ ${pathAnno}`, { kind: 'parity-only', controller, file: f, ...baseAnno });
    }
  }

  return { byKey, warnings };
}

function classifyHistoryStatus(line: string): EndpointStatus {
  const lower = line.toLowerCase();
  if (lower.includes('**skip')) return 'skip';
  if (lower.includes('**defer')) return 'defer';
  if (lower.includes('**migrated') || lower.includes('**done')) return 'migrated';
  if (lower.includes('**tested')) return 'tested';
  if (lower.includes('**in-progress') || lower.includes('**in progress')) return 'in-progress';
  return 'pending';
}

interface HistoryAnnotation { status: EndpointStatus; file: string; }

function parseMigrationHistory(projectPath: string, fileRel: string): Map<string, HistoryAnnotation> {
  const m = new Map<string, HistoryAnnotation>();
  const file = join(projectPath, fileRel);
  if (!existsSync(file)) return m;
  const content = readFileSync(file, 'utf8');
  for (const line of content.split('\n')) {
    const match = line.match(/^- \[[ xX]\]\s+`([^`]+\.java)`\s*[—-]\s*(.+)$/);
    if (!match) continue;
    const javaFile = match[1];
    const status = classifyHistoryStatus(match[2]);
    const ctrlMatch = javaFile.match(/([A-Za-z0-9_$]+)\.java$/);
    const ctrl = ctrlMatch ? ctrlMatch[1] : javaFile;
    m.set(ctrl, { status, file: javaFile });
  }
  return m;
}

export function resolveJavaPathsForEndpoint(
  projectPath: string,
  ep: { method: string; path: string; controller?: string; tag?: string; docFile?: string }
): { legacyJavaPath?: string; newJavaPath?: string } {
  const legacyIndex = buildJavaFileIndex(projectPath, LEGACY_JAVA_ROOTS);
  const newIndex = buildJavaFileIndex(projectPath, NEW_JAVA_ROOTS);
  const legacyUrlIndex = buildUrlIndex(projectPath, LEGACY_JAVA_ROOTS);
  const newUrlIndex = buildUrlIndex(projectPath, NEW_JAVA_ROOTS);

  const tag = ep.tag || ep.controller || '';
  const base = tag.replace(/Controller$/, '');
  const docName = ep.docFile?.replace(/\.md$/i, '');
  const lookup = (idx: Map<string, string>, names: (string | undefined)[]) => {
    for (const n of names) if (n) { const h = idx.get(n); if (h) return h; }
    return undefined;
  };
  const lookupUrl = (idx: UrlIndex) => {
    const direct = idx.exact.get(`${ep.method} ${ep.path}`);
    if (direct) return direct;
    for (const { re, file } of idx.patterns) if (re.test(`${ep.method} ${ep.path}`)) return file;
    return undefined;
  };

  const legacyJavaPath =
    lookup(legacyIndex, [docName, `${base}Service.java`, `${base}.java`, `${tag}.java`]) ||
    lookupUrl(legacyUrlIndex);
  const newJavaPath =
    lookup(newIndex, [`${tag}.java`, `${base}Controller.java`, `${base}.java`]) ||
    lookupUrl(newUrlIndex);

  return { legacyJavaPath, newJavaPath };
}

export interface DiscoveryResult {
  endpoints: Endpoint[];
  warnings: string[];
  sources: { file: string; count: number }[];
  stats: {
    fromOpenApi: number;
    annotatedByDoc: number;
    annotatedByHistory: number;
    stubbed: number;
    pending: number;
    withLegacyJava: number;
    withNewJava: number;
  };
}

// rawSpec is whatever forge.openapi(specPath) returned (or null when missing).
export function discoverEndpoints(projectPath: string, config: MigrationConfig, rawSpec: any | null): DiscoveryResult {
  const warnings: string[] = [];
  const sources: { file: string; count: number }[] = [];

  let openApi: OpenApiDoc | null = null;
  if (rawSpec) openApi = buildOpenApiDoc(rawSpec);
  else if (config.endpointSource.openApiSpec) {
    warnings.push(`OpenAPI spec not found: ${config.endpointSource.openApiSpec}`);
  }

  if (!openApi) return legacyDocDiscovery(projectPath, config);

  const docAnno = parsePerControllerDocs(projectPath, config.endpointSource.primary);
  warnings.push(...docAnno.warnings);
  const historyAnno = config.endpointSource.fallback
    ? parseMigrationHistory(projectPath, config.endpointSource.fallback)
    : new Map<string, HistoryAnnotation>();

  const legacyIndex = buildJavaFileIndex(projectPath, LEGACY_JAVA_ROOTS);
  const newIndex = buildJavaFileIndex(projectPath, NEW_JAVA_ROOTS);
  const legacyUrlIndex = buildUrlIndex(projectPath, LEGACY_JAVA_ROOTS);
  const newUrlIndex = buildUrlIndex(projectPath, NEW_JAVA_ROOTS);

  const tryNames = (idx: Map<string, string>, names: string[]): string | undefined => {
    for (const n of names) { const h = idx.get(n); if (h) return h; }
    return undefined;
  };
  const tryUrl = (idx: UrlIndex, method: string, path: string): string | undefined => {
    const direct = idx.exact.get(`${method} ${path}`);
    if (direct) return direct;
    for (const { re, file } of idx.patterns) {
      if (re.test(`${method} ${path}`)) return file;
    }
    return undefined;
  };

  const resolveLegacy = (anno: DocAnnotation | undefined, tag: string, method: string, path: string): string | undefined => {
    if (anno?.legacyJavaPath) return anno.legacyJavaPath;
    const docName = anno?.file?.replace(/\.md$/i, '');
    const base = tag.replace(/Controller$/, '');
    const guesses = [
      docName,
      `${base}Service.java`,
      `${base}.java`,
      `${tag}.java`,
    ].filter(Boolean) as string[];
    const byName = tryNames(legacyIndex, guesses);
    if (byName) return byName;
    return tryUrl(legacyUrlIndex, method, path);
  };
  const resolveNew = (anno: DocAnnotation | undefined, tag: string, method: string, path: string): string | undefined => {
    if (anno?.newJavaPath) return anno.newJavaPath;
    const base = tag.replace(/Controller$/, '');
    const guesses = [
      `${tag}.java`,
      `${base}Controller.java`,
      `${base}.java`,
    ];
    const byName = tryNames(newIndex, guesses);
    if (byName) return byName;
    return tryUrl(newUrlIndex, method, path);
  };

  const prefixAnnos: { prefix: string; anno: DocAnnotation }[] = [];
  for (const [key, anno] of docAnno.byKey) {
    if (key.startsWith('__PREFIX__ ')) {
      prefixAnnos.push({ prefix: key.slice('__PREFIX__ '.length), anno });
    }
  }

  const endpoints: Endpoint[] = [];
  let annotatedByDoc = 0;
  let annotatedByHistory = 0;
  let stubbed = 0;
  let pending = 0;
  let withLegacyJava = 0;
  let withNewJava = 0;

  for (const op of openApi.operations) {
    const key = `${op.method} ${op.path}`;
    const directAnno = docAnno.byKey.get(key);

    let docNotes: string | undefined;
    let docFile: string | undefined;
    let docKind: SectionKind | undefined;
    let resolvedAnno: DocAnnotation | undefined;

    if (directAnno) {
      docKind = directAnno.kind;
      docFile = directAnno.file;
      docNotes = directAnno.notes;
      resolvedAnno = directAnno;
      annotatedByDoc++;
    } else {
      for (const { prefix, anno } of prefixAnnos) {
        if (op.path === prefix || op.path.startsWith(prefix + '/') || op.path.startsWith(prefix + '?')) {
          docKind = anno.kind;
          docFile = anno.file;
          resolvedAnno = anno;
          break;
        }
      }
    }

    const tag = (op.tags && op.tags[0]) || 'untagged';
    let status: EndpointStatus = 'pending';
    let isStubbed = false;
    let expectedHttpStatus = 200;

    if (docKind === 'migrated') status = 'migrated';
    else if (docKind === 'stubbed' || docKind === 'parity-only') {
      status = 'migrated';
      isStubbed = true;
      expectedHttpStatus = 501;
    } else {
      const hist = historyAnno.get(tag) || historyAnno.get(tag + 'Service') || historyAnno.get(tag + 'Controller');
      if (hist) {
        status = hist.status;
        if (hist.status === 'skip' || hist.status === 'defer') continue;
        annotatedByHistory++;
      }
    }

    if (isStubbed) stubbed++;
    if (status === 'pending') pending++;

    const responseSchema = getResponseSchema(op, openApi);

    const legacyJavaPath = resolveLegacy(resolvedAnno, tag, op.method, op.path);
    const newJavaPath = resolveNew(resolvedAnno, tag, op.method, op.path);
    if (legacyJavaPath) withLegacyJava++;
    if (newJavaPath) withNewJava++;

    endpoints.push({
      id: endpointId(op.method, op.path),
      controller: tag,
      file: docFile,
      docFile,
      method: op.method as HttpMethod,
      path: op.path,
      status,
      expectedHttpStatus,
      isStubbed,
      source: config.endpointSource.openApiSpec || 'openapi',
      notes: docNotes || op.summary,
      operationId: op.operationId,
      tag,
      summary: op.summary,
      hasResponseSchema: !!responseSchema,
      legacyJavaPath,
      newJavaPath,
    });
  }

  if (config.endpointSource.openApiSpec) sources.push({ file: config.endpointSource.openApiSpec, count: endpoints.length });
  if (annotatedByDoc > 0) sources.push({ file: config.endpointSource.primary, count: annotatedByDoc });
  if (annotatedByHistory > 0 && config.endpointSource.fallback) {
    sources.push({ file: config.endpointSource.fallback, count: annotatedByHistory });
  }

  return {
    endpoints, warnings, sources,
    stats: {
      fromOpenApi: openApi.operations.length,
      annotatedByDoc, annotatedByHistory, stubbed, pending,
      withLegacyJava, withNewJava,
    },
  };
}

function legacyDocDiscovery(projectPath: string, config: MigrationConfig): DiscoveryResult {
  const warnings: string[] = [];
  const sources: { file: string; count: number }[] = [];
  const all: Endpoint[] = [];
  const seen = new Set<string>();
  let stubbed = 0;

  const docAnno = parsePerControllerDocs(projectPath, config.endpointSource.primary);
  warnings.push(...docAnno.warnings);

  const legacyIndex = buildJavaFileIndex(projectPath, LEGACY_JAVA_ROOTS);
  const newIndex = buildJavaFileIndex(projectPath, NEW_JAVA_ROOTS);
  const legacyUrlIndex = buildUrlIndex(projectPath, LEGACY_JAVA_ROOTS);
  const newUrlIndex = buildUrlIndex(projectPath, NEW_JAVA_ROOTS);

  for (const [key, anno] of docAnno.byKey) {
    if (key.startsWith('__PREFIX__ ')) continue;
    const [method, path] = key.split(' ');
    const id = endpointId(method, path);
    if (seen.has(id)) continue;
    seen.add(id);
    const isStubbed = anno.kind === 'stubbed' || anno.kind === 'parity-only';
    if (isStubbed) stubbed++;
    const javaName = anno.file.replace(/\.md$/i, '');
    const ctrl = anno.controller;
    const base = ctrl.replace(/Controller$/, '');
    const legacyJavaPath = anno.legacyJavaPath
      || legacyIndex.get(javaName)
      || legacyIndex.get(`${base}Service.java`)
      || legacyIndex.get(`${ctrl}.java`)
      || ((): string | undefined => {
           const direct = legacyUrlIndex.exact.get(`${method} ${path}`);
           if (direct) return direct;
           for (const { re, file } of legacyUrlIndex.patterns) if (re.test(`${method} ${path}`)) return file;
           return undefined;
         })();
    const newJavaPath = anno.newJavaPath
      || newIndex.get(`${ctrl}.java`)
      || newIndex.get(`${base}Controller.java`)
      || ((): string | undefined => {
           const direct = newUrlIndex.exact.get(`${method} ${path}`);
           if (direct) return direct;
           for (const { re, file } of newUrlIndex.patterns) if (re.test(`${method} ${path}`)) return file;
           return undefined;
         })();
    all.push({
      id, controller: anno.controller, file: anno.file, docFile: anno.file,
      method: method as HttpMethod, path,
      status: 'migrated',
      expectedHttpStatus: isStubbed ? 501 : 200,
      isStubbed, source: anno.file, notes: anno.notes,
      legacyJavaPath, newJavaPath,
    });
  }
  if (all.length > 0) sources.push({ file: config.endpointSource.primary, count: all.length });

  const withLegacyJava = all.filter(e => !!e.legacyJavaPath).length;
  const withNewJava = all.filter(e => !!e.newJavaPath).length;
  return {
    endpoints: all, warnings, sources,
    stats: {
      fromOpenApi: 0, annotatedByDoc: all.length, annotatedByHistory: 0, stubbed, pending: 0,
      withLegacyJava, withNewJava,
    },
  };
}
