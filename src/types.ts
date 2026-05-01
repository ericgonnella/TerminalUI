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

/** Where this instance lives. Controls security posture:
 *  - 'local':  personal machine, bound to loopback, keychain-stored credentials.
 *  - 'hosted': server / shared host, stricter password policy, audit log always on,
 *              warns about network exposure. */
export type InstallationType = 'local' | 'hosted';

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
  /**
   * Runtime-only plaintext password. Hydrated from the credential vault on
   * load; NEVER serialized to disk. `config.ts` strips this field before
   * writing. Components must not log or display this value.
   */
  password?: string;
  /** True if this instance was imported externally rather than initialised by this app. */
  external?: boolean;
  /** Installation security posture. Defaults to 'local' for legacy instances. */
  installationType?: InstallationType;
  /**
   * ISO-8601 timestamp of the last credential rotation (vault write).
   * Used by the security probe to warn when >90 days have elapsed.
   * Set by NewInstanceScreen / ImportInstanceScreen on creation, and by
   * UsersScreen when changeRolePassword is called.
   */
  passwordChangedAt?: string;
  /** PostgreSQL version used to initialise this instance, e.g. "17.4". Set at creation time. */
  pgVersion?: string;
  /** External / remote access configuration. See RemoteAccessConfig.
   *  Persisted to config.json — contains no secrets, only IP allow-lists and
   *  paths to user-managed tunnel service files. */
  remoteAccess?: RemoteAccessConfig;
}

// ─── External / Remote Access ─────────────────────────────────────────────────

/** A single client allow-list entry. CIDR is normalised — bare IPs become /32 (v4) or /128 (v6). */
export interface CidrEntry {
  cidr:    string;
  addedAt: string;
}

/** A reverse SSH tunnel published from the pgmanager host to a remote machine.
 *  Service file lives on the pgmanager host (systemd unit / launchd plist /
 *  Windows scheduled task) and opens an SSH connection out to `remoteHost`,
 *  binding `remotePort` there back to PostgreSQL on 127.0.0.1:<instance.port>. */
export interface SshTunnelEntry {
  /** SSH user on the remote host. */
  sshUser:         string;
  /** Reachable hostname or IP of the remote machine that needs DB access. */
  remoteHost:      string;
  /** SSH port on the remote host. Default 22. */
  sshPort:         number;
  /** Port that will be opened on the remote host (bound to 127.0.0.1 there). */
  remotePort:      number;
  /** Path to the service file we generated on the pgmanager host. */
  serviceFilePath?: string;
  /** Service / unit / scheduled task name registered with the OS supervisor. */
  serviceName?:    string;
  configuredAt:    string;
}

export interface RemoteAccessConfig {
  /** Direct TCP allow-list — applied to pg_hba.conf and the host firewall. */
  directCidrs:        CidrEntry[];
  /** Reverse SSH tunnel definitions. */
  sshTunnels:         SshTunnelEntry[];
  /** True once we have edited postgresql.conf to bind on all interfaces.
   *  Used to decide whether a restart (rather than a reload) is needed when
   *  applying further changes. */
  listenAllUpdated:   boolean;
  lastUpdatedAt?:     string;
}

// ─── Project database provisioning ───────────────────────────────────────────

/**
 * Network/security access mode for a project database.
 * Controls which firewall and pg_hba.conf rules are applied.
 */
export type AccessMode =
  | 'internal'             // same-VPS loopback only; no public exposure
  | 'testing_open'         // public internet, no IP restrictions (TEMPORARY)
  | 'testing_allowlist'    // public internet, specific IPs only (TEMPORARY)
  | 'production_local'     // same-VPS production; loopback only + backups
  | 'production_allowlist' // external backend; strict IP allowlist + TLS
  | 'production_vpn';      // VPN/private network only

/**
 * Where the backend API that connects to this database is hosted.
 * Drives which host is embedded in the recommended DATABASE_URL.
 */
export type BackendLocation =
  | 'same_vps'
  | 'same_vps_docker'
  | 'external_vps'
  | 'netlify_functions'
  | 'vercel_functions'
  | 'local_dev_machine'
  | 'unknown';

/** Framework target for .env template generation. */
export type EnvTarget =
  | 'node_express'
  | 'prisma'
  | 'drizzle'
  | 'netlify_frontend'
  | 'external_vps';

/** A project database record stored alongside the instance config. */
export interface ProjectDatabase {
  id:               string;   // `${instanceId}:${databaseName}`
  instanceId:       string;
  databaseName:     string;
  appUser:          string;
  projectName:      string;
  accessMode:       AccessMode;
  backendLocation:  BackendLocation;
  allowedCidrs:     string[];
  publicIp?:        string;
  useTls:           boolean;
  createdAt:        string;
  lastHealthCheck?: ProjectHealthCheck;
}

export interface ProjectHealthCheck {
  checkedAt:     string;
  pgIsReady:     'passed' | 'failed' | 'skipped';
  localSql:      'passed' | 'failed' | 'skipped';
  listener:      'passed' | 'failed' | 'skipped' | 'warning';
  firewallCheck: 'passed' | 'failed' | 'skipped' | 'warning';
  details:       string[];
}

export interface ProjectWarning {
  level:   'error' | 'warning' | 'info';
  code:    string;
  message: string;
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
  | 'database-detail'
  | 'provision-app'
  | 'remote-access'
  | 'hosted-setup'
  | 'cloudflare-tunnel'
  | 'project-database';

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
export interface ProvisionAppScreen    { name: 'provision-app';    instance: Instance }
export interface RemoteAccessScreen    { name: 'remote-access';    instance: Instance }
export interface HostedSetupScreen     { name: 'hosted-setup';     instance: Instance }
export interface CloudflareTunnelScreen { name: 'cloudflare-tunnel'; instance: Instance }
export interface ProjectDatabaseScreen { name: 'project-database'; instance: Instance }

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
  | DatabaseDetailScreen
  | ProvisionAppScreen
  | RemoteAccessScreen
  | HostedSetupScreen
  | CloudflareTunnelScreen
  | ProjectDatabaseScreen;
