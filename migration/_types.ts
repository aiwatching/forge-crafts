// Migration types — copied from forge/lib/migration/types.ts.
// Kept local so the craft is self-contained.

export type EndpointStatus = 'pending' | 'in-progress' | 'migrated' | 'tested' | 'skip' | 'defer';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export interface Endpoint {
  id: string;
  controller: string;
  file?: string;
  method: HttpMethod;
  path: string;
  status: EndpointStatus;
  expectedHttpStatus: number;
  isStubbed: boolean;
  source: string;
  notes?: string;
  acceptance?: string[];
  operationId?: string;
  tag?: string;
  summary?: string;
  hasResponseSchema?: boolean;
  docFile?: string;
}

export interface RunResult {
  endpointId: string;
  startedAt: string;
  durationMs: number;
  legacy: SideResult;
  next: SideResult;
  match: 'pass' | 'fail' | 'stub-ok' | 'error' | 'flagged';
  diff?: DiffEntry[];
  errorType?: string;
  errorMessage?: string;
  flagged?: { flag: Annotation['flag']; note: string };
}

export interface SideResult {
  url: string;
  method?: HttpMethod;
  status: number;
  statusText?: string;
  ok: boolean;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  bodyExcerpt?: string;
  bodyJson?: any;
  error?: string;
  durationMs: number;
}

export interface DiffEntry {
  jsonPath: string;
  legacy: any;
  next: any;
  reason: 'value' | 'missing-in-next' | 'missing-in-legacy' | 'type-mismatch';
}

export interface Annotation {
  endpointId: string;
  flag: 'deviated' | 'accepted' | 'wontfix' | 'flaky';
  note: string;
  ignorePaths?: string[];
  flaggedAt: string;
  flaggedBy?: string;
}

export interface Failure {
  endpointId: string;
  controller: string;
  method: HttpMethod;
  path: string;
  errorType: string;
  errorMessage: string;
  lastSeenAt: string;
}

export interface FailureCluster {
  errorType: string;
  count: number;
  controllers: { controller: string; failures: Failure[] }[];
}

export type DiffMode = 'exact' | 'shape' | 'both';

export interface MigrationConfig {
  legacy: { baseUrl: string };
  next: { baseUrl: string; sourceDir?: string };
  auth: {
    mode: 'skip' | 'bearer' | 'basic';
    tokenEnv?: string;
    username?: string;
    passwordEnv?: string;
  };
  ignorePaths: string[];
  healthCheck: {
    legacyTimeout: number;
    newTimeout: number;
    skipUnhealthy: boolean;
  };
  clusterMode: 'simple' | 'ai';
  diffMode: DiffMode;
  lenientNullable?: boolean;
  endpointSource: {
    type: 'docs' | 'openapi' | 'source-scan' | 'mixed';
    primary: string;
    fallback?: string;
    openApiSpec?: string;
  };
  pathSubstitutions?: Record<string, string>;
}

export const DEFAULT_CONFIG: MigrationConfig = {
  legacy: { baseUrl: 'http://localhost:8080' },
  next: { baseUrl: 'http://localhost:9090' },
  auth: { mode: 'skip' },
  ignorePaths: ['$.timestamp', '$.requestId', '$.traceId'],
  healthCheck: { legacyTimeout: 2000, newTimeout: 2000, skipUnhealthy: true },
  clusterMode: 'simple',
  diffMode: 'shape',
  lenientNullable: true,
  endpointSource: {
    type: 'mixed',
    primary: 'docs/migration',
    fallback: 'docs/lead/migration-history.md',
    openApiSpec: 'docs/fnac-rest-schema-7.6.json',
  },
  pathSubstitutions: { id: '1', dbid: '1', ip: '127.0.0.1', mac: '00:00:00:00:00:00' },
};
