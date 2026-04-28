// Diagnosis prompt builder — categorizes the failure and emits a targeted
// markdown playbook. Ported from forge/lib/migration/diagnose.ts.

import type { Endpoint, RunResult, Annotation, MigrationConfig } from './_types';
import { lookup, getResponseSchema, type OpenApiDoc } from './_openapi';
import { curlFor } from './_runner';

export interface DiagnosisContext {
  endpoint: Endpoint;
  result?: RunResult;
  schema?: any;
  operationId?: string;
  tag?: string;
  parameters?: any[];
  docContent?: string;
  docPath?: string;
  curlCommand: string;
  annotation?: Annotation | null;
}

function fence(lang: string, body: string): string { return '```' + lang + '\n' + body + '\n```'; }

function summarizeResult(r: RunResult | undefined): string {
  if (!r) return '_(no run result yet — endpoint has not been tested)_';
  const lines: string[] = [];
  lines.push(`**Last run**: ${r.startedAt} (${r.durationMs}ms) — match=\`${r.match}\`${r.errorType ? ` · ${r.errorType}` : ''}`);
  if (r.errorMessage) lines.push(`**Error**: ${r.errorMessage}`);
  lines.push('');
  lines.push(`**New side**: ${r.next.url}`);
  lines.push(`HTTP \`${r.next.status}\` · ${r.next.durationMs}ms${r.next.error ? ` · ${r.next.error}` : ''}`);
  if (r.next.bodyExcerpt) {
    lines.push('Response body:');
    lines.push(fence('json', r.next.bodyExcerpt.slice(0, 4000)));
  }
  if (r.legacy.url && !r.legacy.url.startsWith('(skipped')) {
    lines.push(`**Legacy side**: ${r.legacy.url}`);
    lines.push(`HTTP \`${r.legacy.status}\` · ${r.legacy.durationMs}ms${r.legacy.error ? ` · ${r.legacy.error}` : ''}`);
    if (r.legacy.bodyExcerpt) {
      lines.push('Response body:');
      lines.push(fence('json', r.legacy.bodyExcerpt.slice(0, 4000)));
    }
  }
  if (r.diff && r.diff.length > 0) {
    lines.push('');
    lines.push(`**Diffs / violations** (${r.diff.length} total, showing up to 30):`);
    for (const d of r.diff.slice(0, 30)) {
      lines.push(`- \`${d.jsonPath}\`: ${d.reason} — expected \`${JSON.stringify(d.legacy)}\`, got \`${JSON.stringify(d.next)}\``);
    }
  }
  return lines.join('\n');
}

export type FailureCategory =
  | 'no-result' | 'pass'
  | 'new-unreachable' | 'legacy-unreachable'
  | 'http-5xx' | 'http-404' | 'http-401-403' | 'http-other'
  | 'http-status-mismatch' | 'stub-not-501'
  | 'schema-violation-types' | 'schema-violation-missing'
  | 'schema-violation-enum' | 'schema-violation-mixed'
  | 'json-diff-values' | 'unknown-fail';

export function categorizeFailure(ctx: DiagnosisContext): FailureCategory {
  const r = ctx.result;
  if (!r) return 'no-result';
  if (r.match === 'pass' || r.match === 'stub-ok') return 'pass';
  if (r.errorType === 'new-unreachable') return 'new-unreachable';
  if (r.errorType === 'legacy-unreachable') return 'legacy-unreachable';
  if (r.errorType === 'stub-not-501') return 'stub-not-501';
  if (r.errorType === 'http-status-mismatch') return 'http-status-mismatch';
  if (r.errorType === 'http-status') {
    const code = r.next.status;
    if (code >= 500) return 'http-5xx';
    if (code === 404) return 'http-404';
    if (code === 401 || code === 403) return 'http-401-403';
    return 'http-other';
  }
  if (r.errorType === 'schema-violation' && r.diff && r.diff.length > 0) {
    const reasons = r.diff.map(d => d.reason);
    const allMissing = reasons.every(x => x === 'missing-in-next');
    const allTypes = reasons.every(x => x === 'type-mismatch');
    const enumLike = r.diff.filter(d => /enum/i.test(String(d.legacy))).length;
    if (allMissing) return 'schema-violation-missing';
    if (allTypes) return 'schema-violation-types';
    if (enumLike > r.diff.length / 2) return 'schema-violation-enum';
    return 'schema-violation-mixed';
  }
  if (r.errorType === 'json-diff') return 'json-diff-values';
  return 'unknown-fail';
}

function targetedPlaybook(cat: FailureCategory, ctx: DiagnosisContext): string[] {
  const r = ctx.result; const ep = ctx.endpoint; const lines: string[] = [];
  switch (cat) {
    case 'new-unreachable':
      lines.push('### Likely cause: new server is not running or wrong baseUrl');
      lines.push(`Forge tried \`${r?.next.url}\` and the fetch failed before any HTTP exchange.`);
      lines.push('');
      lines.push('1. `curl -i ' + (r?.next.url || '') + '` from a shell — same error?');
      lines.push('2. Is the configured `next.baseUrl` pointing at the right port/host?');
      lines.push('3. If only this controller fails: maybe it isn\'t mounted (no `@RestController` / wrong package scan).');
      break;
    case 'legacy-unreachable':
      lines.push('### Legacy server is down');
      lines.push('Either start it, or switch the cockpit to `shape` diff mode (Config → Diff mode) so legacy isn\'t needed.');
      break;
    case 'http-404':
      lines.push('### Likely cause: route not registered in the new module');
      lines.push(`\`${ep.method} ${ep.path}\` returned 404.`);
      lines.push('');
      lines.push('1. Has this controller been migrated yet? Check this project\'s migration tracker (e.g. `docs/lead/migration-history.md`).');
      lines.push('2. If it should be migrated: is it in the component scan? Is the `@RequestMapping` / `@GetMapping` path correct?');
      lines.push('3. If the controller hasn\'t been migrated, say so and stop — don\'t invent code.');
      break;
    case 'http-5xx': {
      const body = r?.next.bodyExcerpt || '';
      lines.push('### Likely cause: handler threw an exception');
      lines.push(`HTTP \`${r?.next.status}\`. The response body usually contains the stack trace — read it carefully.`);
      lines.push('');
      lines.push('1. Find the exception class and message in the response body.');
      lines.push('2. Open the controller for this endpoint — what does the failing line do?');
      lines.push('3. Common causes: missing `@Service` bean, NPE because a DAO returned `null`, JPA query mismatch.');
      if (/NullPointerException|NPE/.test(body)) lines.push('4. **NPE detected** — trace which collaborator returned null.');
      if (/NoSuchBeanDefinition|UnsatisfiedDependency/.test(body)) lines.push('4. **Spring DI failure** — a bean isn\'t available.');
      if (/SQLException|JpaSystemException|QueryException/.test(body)) lines.push('4. **JPA/SQL error** — DAO query needs adjusting; check entity/column names.');
      break;
    }
    case 'http-401-403':
      lines.push('### Security blocking the request');
      lines.push(`Forge sent: ${r?.next.requestHeaders?.Authorization ? 'Authorization header' : 'no Authorization header'}.`);
      lines.push('1. Cockpit auth mode in Config — for parity testing in dev, you usually want the new module\'s security to `permitAll` for these paths.');
      lines.push('2. If auth IS required: set `auth.mode = bearer` in cockpit Config and provide `tokenEnv`.');
      break;
    case 'http-other':
      lines.push(`### HTTP \`${r?.next.status}\` — read the response body for the error envelope.`);
      break;
    case 'http-status-mismatch':
      lines.push('### Status code logic differs from legacy');
      lines.push(`Legacy returned \`${r?.legacy.status}\`, new returned \`${r?.next.status}\`.`);
      lines.push('1. Check error/exception mapping. Legacy likely has a different `ExceptionMapper` / `@ControllerAdvice` shape.');
      lines.push('2. Empty results: legacy returns 200 with empty `results: []`, new might 404.');
      break;
    case 'stub-not-501':
      lines.push('### A "stubbed" endpoint actually returned a real response');
      lines.push(`Marked as stubbed but returned \`${r?.next.status}\`. Either the endpoint really IS migrated now (update the migration doc), or revert to the explicit 501 stub.`);
      break;
    case 'schema-violation-types': {
      const examples = (r?.diff || []).slice(0, 5).map(d => `\`${d.jsonPath}\` (expected ${d.legacy}, got ${d.next})`).join(', ');
      lines.push('### DTO field types don\'t match the spec');
      lines.push(`All ${r?.diff?.length} mismatches are type errors. Examples: ${examples}.`);
      lines.push('1. Find the response DTO class. Compare each Java field type against the OpenAPI schema above.');
      lines.push('2. Common culprits: `Integer` vs `String`, `Long` vs `String`, `Boolean` vs `String`.');
      lines.push('3. If the spec is wrong, add the path to `ignorePaths` rather than changing the spec.');
      break;
    }
    case 'schema-violation-missing': {
      const fields = (r?.diff || []).slice(0, 8).map(d => `\`${d.jsonPath}\``).join(', ');
      lines.push('### Required fields not populated');
      lines.push(`Missing: ${fields}${(r?.diff?.length ?? 0) > 8 ? ' …' : ''}.`);
      lines.push('1. Look at the new module\'s mapper / DTO assembler.');
      lines.push('2. Likely causes: Entity → DTO mapping that lost a field; `@JsonInclude(NON_NULL)` swallowing legitimate nulls; service returning a partial DTO.');
      break;
    }
    case 'schema-violation-enum':
      lines.push('### Enum values out of spec');
      lines.push('Some response field returned a value not in the OpenAPI enum. Check case sensitivity, constant renames, or whether spec\'s enum is incomplete.');
      break;
    case 'schema-violation-mixed':
      lines.push('### Multiple shape problems — likely wholesale DTO mismatch');
      lines.push('1. Compare actual response body against schema side by side.');
      lines.push('2. Often the new module is using a different DTO class.');
      lines.push('3. Verify Jackson annotations match (`@JsonProperty`, `@JsonIgnore`, naming strategy).');
      break;
    case 'json-diff-values':
      lines.push('### Same shape, different values');
      lines.push('1. Ignorable fields (timestamps, IDs) → add to `ignorePaths`.');
      lines.push('2. Real differences: DAO query / service logic differs (different source / sorting / stale data).');
      break;
    case 'no-result': lines.push('### No run result yet — run the endpoint first.'); break;
    case 'pass': lines.push('### This endpoint passes — no fix needed.'); break;
    default: lines.push('### Generic guidance — read the run result and consult the project\'s migration playbook.');
  }
  return lines;
}

export function renderDiagnosisMarkdown(ctx: DiagnosisContext, opts: { generic?: boolean } = {}): string {
  const ep = ctx.endpoint;
  const cat = categorizeFailure(ctx);
  const lines: string[] = [];

  lines.push(`# Migration parity failure: \`${ep.method} ${ep.path}\``);
  if (!opts.generic) lines.push(`> Auto-tailored prompt — failure category: \`${cat}\``);
  lines.push('');
  lines.push('> Use this project\'s CLAUDE.md and migration playbook to locate source files. Forge does not assume paths.');
  lines.push('');
  lines.push(`- **Controller / tag**: \`${ep.controller}\``);
  if (ctx.operationId) lines.push(`- **OpenAPI operationId**: \`${ctx.operationId}\``);
  lines.push(`- **Status**: \`${ep.status}\`${ep.isStubbed ? ' · stubbed (expects 501)' : ''}`);
  if (ep.summary) lines.push(`- **Summary**: ${ep.summary}`);
  if (ctx.docPath) lines.push(`- **Migration doc** (this project): \`${ctx.docPath}\``);
  lines.push('');

  if (ctx.annotation) {
    lines.push(`> ⚠ This endpoint is **flagged as \`${ctx.annotation.flag}\`** by the project owner. Note: ${ctx.annotation.note || '(no note)'}.`);
    if (ctx.annotation.ignorePaths?.length) {
      lines.push(`> Per-endpoint ignored paths: ${ctx.annotation.ignorePaths.map(p => `\`${p}\``).join(', ')}`);
    }
    lines.push('');
  }

  lines.push('## Reproduce manually');
  lines.push(fence('bash', ctx.curlCommand));
  lines.push('');

  lines.push('## Run result (captured by Forge)');
  lines.push(summarizeResult(ctx.result));
  lines.push('');

  const schemaRelevant = !opts.generic ? (cat.startsWith('schema-violation') || cat === 'json-diff-values' || cat === 'http-status-mismatch') : true;
  if (ctx.schema && schemaRelevant) {
    lines.push('## Expected response schema (from OpenAPI)');
    lines.push(fence('json', JSON.stringify(ctx.schema, null, 2).slice(0, 4000)));
    lines.push('');
  }

  const sourceRelevant = !opts.generic ? (cat === 'http-5xx' || cat === 'http-404' || cat.startsWith('schema-violation') || cat === 'json-diff-values' || cat === 'http-status-mismatch' || cat === 'stub-not-501') : true;
  if (sourceRelevant) {
    if (ctx.parameters && ctx.parameters.length > 0) {
      lines.push('## OpenAPI parameters');
      lines.push(fence('json', JSON.stringify(ctx.parameters, null, 2)));
      lines.push('');
    }
    if (ctx.docContent) {
      lines.push('## Migration doc content (snippet)');
      lines.push(fence('markdown', ctx.docContent));
      lines.push('');
    }
  }

  lines.push('## What to do');
  if (opts.generic) {
    lines.push('1. Consult this project\'s CLAUDE.md and migration playbook.');
    lines.push('2. Compare actual response to expected schema.');
    lines.push('3. Apply minimal fix; legacy is the contract.');
    lines.push('4. Re-run the parity test from the Forge Migration craft.');
  } else {
    lines.push(...targetedPlaybook(cat, ctx));
  }
  lines.push('');
  lines.push('Report back with: files edited, the specific fix in 1-2 sentences, and any assumption you had to make.');

  return lines.join('\n');
}

export function renderBatchDiagnosis(ctxs: DiagnosisContext[]): string {
  const lines: string[] = [];
  lines.push(`# Migration parity batch fix — ${ctxs.length} failing endpoints`);
  lines.push('');
  lines.push('Each section below contains one failing endpoint. Fix them one at a time; legacy code MUST NOT be modified.');
  lines.push('');
  for (const ctx of ctxs) {
    lines.push('---');
    lines.push('');
    lines.push(renderDiagnosisMarkdown(ctx));
    lines.push('');
  }
  return lines.join('\n');
}

// Build a context given an endpoint + the batch's openApi + annotation lookup.
// Doc content + path are loaded from disk by the caller (server.ts) since we
// need fs access there.
export function makeContext(args: {
  endpoint: Endpoint;
  result?: RunResult;
  openApi?: OpenApiDoc | null;
  annotation?: Annotation | null;
  docContent?: string;
  docPath?: string;
  config: MigrationConfig;
}): DiagnosisContext {
  const { endpoint, result, openApi, annotation, docContent, docPath, config } = args;
  let schema: any = undefined;
  let operationId: string | undefined;
  let tag: string | undefined;
  let parameters: any[] | undefined;
  if (openApi) {
    const op = lookup(openApi, endpoint.method, endpoint.path);
    if (op) {
      schema = getResponseSchema(op, openApi);
      operationId = op.operationId;
      tag = op.tags?.[0];
      parameters = op.parameters;
    }
  }
  return {
    endpoint, result, schema, operationId, tag, parameters,
    docContent, docPath, annotation,
    curlCommand: curlFor(config.next.baseUrl, endpoint, config),
  };
}
