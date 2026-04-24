// ─── Log / Activity types (reused by components) ────────────────────────────

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export interface LogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
}

// ─── Postgres Instance types ──────────────────────────────────────────────────

export type InstanceStatus = 'running' | 'stopped' | 'unknown' | 'error';

export interface Instance {
  id: string;
  name: string;
  port: number;
  dataDir: string;
  superuser: string;
  createdAt: string;
  lastMigrationsDir?: string;
  /** Hostname or IP. Defaults to 127.0.0.1 when unset. */
  host?: string;
  /** Windows only: service name used by net start/stop when pg_ctl is unavailable. */
  winServiceName?: string;
  /** Linux only: systemd unit name used by systemctl start/stop/status. */
  systemdService?: string;
  /** True if scram-sha-256 auth was set during initdb (i.e. user chose a password). */
  hasPassword?: boolean;
  /** Stored password for instances that require password auth (e.g. external instances). */
  password?: string;
  /** True if this instance was imported externally rather than initialised by this app. */
  external?: boolean;
}

export interface DatabaseInfo {
  name: string;
  owner: string;
  encoding: string;
  sizePretty: string;
}

export interface UserInfo {
  name: string;
  superuser: boolean;
  canLogin: boolean;
  replication: boolean;
  connectionLimit: number;
}

export interface TableInfo {
  schema: string;
  name: string;
  rowEstimate: number;
  sizePretty: string;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
}

export interface MigrationRecord {
  filename: string;
  appliedAt: string;
}

// ─── Screen navigation types ──────────────────────────────────────────────────

export type ScreenName =
  | 'home'
  | 'new-instance'
  | 'import-instance'
  | 'instance'
  | 'databases'
  | 'users'
  | 'migrations'
  | 'table-browser'
  | 'query'
  | 'download-pg'
  | 'database-detail';

export interface HomeScreen       { name: 'home' }
export interface NewInstanceScreen { name: 'new-instance' }
export interface ImportInstanceScreen { name: 'import-instance' }
export interface InstanceScreen   { name: 'instance';      instance: Instance }
export interface DatabasesScreen  { name: 'databases';     instance: Instance; database?: string }
export interface UsersScreen      { name: 'users';         instance: Instance }
export interface MigrationsScreen { name: 'migrations';    instance: Instance; database: string }
export interface TableBrowserScreen  { name: 'table-browser';   instance: Instance; database: string }
export interface QueryScreen         { name: 'query';           instance: Instance; database: string }
export interface DownloadPgScreen    { name: 'download-pg' }
export interface DatabaseDetailScreen { name: 'database-detail'; instance: Instance; database: string }

export type ScreenDef =
  | HomeScreen
  | NewInstanceScreen
  | ImportInstanceScreen
  | InstanceScreen
  | DatabasesScreen
  | UsersScreen
  | MigrationsScreen
  | TableBrowserScreen
  | QueryScreen
  | DownloadPgScreen
  | DatabaseDetailScreen;
