/**
 * LinksQL — TypeScript declarations for the public API.
 */

/** A stored link (doublet): an identity plus its source and target. */
export interface Link {
  index: number;
  source: number;
  target: number;
}

/** The kind of a reference node in the parsed notation. */
export type RefKind = 'number' | 'name' | 'variable' | 'wildcard';

/** A reference node: a number, name, `$variable` or `*` wildcard. */
export interface RefNode {
  type: 'ref';
  kind: RefKind;
  value: number | string;
}

/** A link node: an optional identity and an ordered list of values. */
export interface LinkNode {
  type: 'link';
  id: RefNode | null;
  values: Node[];
}

/** Any node produced by the parser. */
export type Node = RefNode | LinkNode;

/** A single lexical token. */
export interface Token {
  type: string;
  value?: string | number;
}

export class LinoSyntaxError extends Error {}

export function tokenize(input: string): Token[];
export function parse(input: string): Node[];
export function serialize(node: Node): string;
export function serializeAll(nodes: Node[], joiner?: string): string;

/** A binding row: variable values plus the concrete links matched, in order. */
export interface BindingRow {
  binding: Record<string, number>;
  links: Link[];
}

/** The classified outcome of an operation. */
export type Operation =
  | 'read'
  | 'create'
  | 'update'
  | 'delete'
  | 'mixed'
  | 'noop';

/** The structured, JSON-serialisable result of a query. */
export interface QueryReport {
  operation: Operation;
  matched: BindingRow[];
  created: Link[];
  updated: Link[];
  deleted: Link[];
}

/** The execution context passed to the matching/substitution primitives. */
export interface Context {
  store: LinksStore;
  names?: Names;
}

export class LinkIntegrityError extends Error {}

export class LinksStore {
  readonly size: number;
  has(index: number): boolean;
  get(index: number): Link | undefined;
  findByPair(source: number, target: number): Link | undefined;
  all(): Link[];
  allocateIndex(): number;
  reserveIndex(index: number): void;
  create(spec: { index?: number; source: number; target: number }): Link;
  update(
    index: number,
    spec: { source: number; target: number; newIndex?: number }
  ): Link;
  delete(index: number): boolean;
  clear(): void;
}

export class UnknownNameError extends Error {}

export class Names {
  constructor(store: LinksStore, options?: { autoCreate?: boolean });
  resolve(name: string): number | undefined;
  ensure(name: string): number;
  bind(name: string, index: number): number;
  nameOf(index: number): string | undefined;
  entries(): Array<[string, number]>;
}

export class SubstitutionError extends Error {}

export function linkSlots(node: LinkNode): {
  id: Node | null;
  source: Node | null;
  target: Node | null;
};
export function match(restriction: Node[], ctx: Context): BindingRow[];
export function execute(
  restriction: Node[],
  substitution: Node[],
  ctx: Context
): {
  matches: BindingRow[];
  created: Link[];
  updated: Link[];
  deleted: Link[];
};
export function linkMatches(
  patterns: Node[],
  link: Link,
  ctx: Context
): boolean;

export class QueryError extends Error {}

export function splitQuery(nodes: Node[]): {
  restriction: Node[];
  substitution: Node[] | null;
};
export function linkToLino(link: Link): string;

/** A LinksQL database: a links store plus a name registry and change stream. */
export class Database {
  constructor(options?: { autoCreate?: boolean });
  readonly store: LinksStore;
  readonly names: Names;
  readonly context: Context;
  onChange(listener: (change: QueryReport) => void): () => void;
  emit(report: QueryReport): void;
  query(text: string): QueryReport;
  links(): Link[];
  count(): number;
  toLino(): string;
  importLino(text: string): number;
  introspect(): {
    linkCount: number;
    names: Array<{ name: string; index: number }>;
    links: Link[];
  };
  clear(): void;
}

export function createDatabase(options?: { autoCreate?: boolean }): Database;

/** The trigger persistence modes (link-cli's `--never`/`--once`/`--always`). */
export type TriggerMode = 'never' | 'once' | 'always';
export const TRIGGER_MODES: readonly TriggerMode[];

export class TriggerError extends Error {}

/** A subscription event: the operation name and the links that matched. */
export interface SubscriptionEvent {
  operation: string;
  matching: Link[];
}

export class Subscriptions {
  constructor(db: Database);
  readonly size: number;
  subscribe(
    patternText: string,
    callback: (event: SubscriptionEvent) => void
  ): () => void;
  dispatch(change: QueryReport): void;
  dispose(): void;
}

/** An installed transformation rule. */
export interface TriggerRule {
  queryText: string;
  readText: string;
  mode: TriggerMode;
  onFire: ((report: QueryReport, rule: TriggerRule) => void) | null;
  active: boolean;
  fired: number;
  lastReport: QueryReport | null;
}

export class Triggers {
  constructor(db: Database, options?: { maxIterations?: number });
  readonly size: number;
  add(
    queryText: string,
    options?: {
      mode?: TriggerMode;
      onFire?: (report: QueryReport, rule: TriggerRule) => void;
    }
  ): TriggerRule;
  remove(rule: TriggerRule): boolean;
  dispose(): void;
}

export interface ServerOptions {
  database?: Database;
  autoCreate?: boolean;
  name?: string;
  version?: string;
  port?: number;
  host?: string;
}

export class LinksQLServer {
  constructor(options?: ServerOptions);
  readonly db: Database;
  readonly subscriptions: Subscriptions;
  readonly url: string;
  listen(port?: number, host?: string): Promise<{ port: number; host: string }>;
  close(): Promise<void>;
}

export function startServer(options?: ServerOptions): Promise<LinksQLServer>;

/** A handle for a live subscription stream. */
export interface SubscriptionHandle {
  ready: Promise<void>;
  done: Promise<void>;
  close(): void;
}

export class LinksQLClient {
  constructor(baseUrl: string, options?: { fetch?: typeof fetch });
  query(text: string): Promise<QueryReport>;
  links(): Promise<Link[]>;
  introspect(): Promise<{
    linkCount: number;
    names: Array<{ name: string; index: number }>;
    links: Link[];
  }>;
  importLino(text: string): Promise<number>;
  export(): Promise<string>;
  subscribe(
    pattern: string,
    onEvent: (event: SubscriptionEvent) => void,
    options?: { signal?: AbortSignal }
  ): SubscriptionHandle;
}
