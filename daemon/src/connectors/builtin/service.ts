// Serves ant-bot's built-in connectors and holds the only thing that can reach their tokens.
//
// The agent runtime mounts a built-in connector as an ordinary http MCP server pointing back at
// the daemon (`/mcp/<name>`). The provider token never travels: the runtime gets a per-boot bearer
// for the daemon's own endpoint, and the daemon exchanges that for the provider's credential at
// call time. Restarting the daemon rotates the bearer, so a value that leaked into a transcript
// or a log is dead by the next boot.
import crypto from 'node:crypto';
import type { Connector } from '@antbot/contract';
import type { MountedConnector } from '../../agent/runtime.js';
import type { ConnectorAuthService } from '../auth.js';
import { BUILTIN_CATALOG, type BuiltinConnector } from './catalog.js';
import { handleMcpRequest, type JsonRpcResponse } from './mcpServer.js';

export class BuiltinService {
  /** Rotates every boot. Checked on every `/mcp/<name>` request. */
  readonly bearer = crypto.randomBytes(24).toString('base64url');

  constructor(
    private readonly auth: ConnectorAuthService | undefined,
    private readonly portOf: () => number,
    private readonly version: string,
  ) {}
  private get port(): number {
    return this.portOf();
  }

  get(name: string): BuiltinConnector | undefined {
    return BUILTIN_CATALOG[name];
  }

  /** The config a built-in connector's row stores: the daemon's own endpoint, nothing secret. */
  rowConfig(name: string): Connector['config'] {
    return { transport: 'http', url: `http://127.0.0.1:${this.port}/mcp/${name}`, headers: {} };
  }

  /** What actually gets mounted: the row's config plus this boot's bearer. */
  mountConfig(connector: Connector): MountedConnector {
    return {
      type: 'http',
      url: `http://127.0.0.1:${this.port}/mcp/${connector.name}`,
      headers: { Authorization: `Bearer ${this.bearer}` },
    };
  }

  authorized(name: string): boolean {
    return this.auth?.isAuthorized(name) ?? false;
  }

  /** Constant-time compare so the bearer cannot be guessed a byte at a time. */
  checkBearer(header: string | undefined): boolean {
    const given = (header ?? '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(given);
    const b = Buffer.from(this.bearer);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** Serve one MCP request for a built-in connector. */
  async handle(name: string, body: unknown): Promise<JsonRpcResponse | null> {
    const def = this.get(name);
    if (!def) return { jsonrpc: '2.0', id: null, error: { code: -32601, message: `No built-in connector named ${name}` } };
    return handleMcpRequest(body, { name: def.name, version: this.version, tools: def.tools() }, async () => {
      const hdr = await this.auth?.authHeader(name);
      if (!hdr) {
        throw new Error(
          `${def.displayName} is not signed in. Sign in on the Connectors screen or with \`antbot mcp login ${name}\`.`,
        );
      }
      return { accessToken: hdr.Authorization.replace(/^Bearer\s+/, '') };
    });
  }

  /** Start the provider sign-in for a built-in connector. Returns the URL to open. */
  async beginLogin(connector: Connector, opts: { clientId?: string; clientSecret?: string } = {}): Promise<string> {
    const def = this.get(connector.name);
    if (!def) throw new Error(`No built-in connector named ${connector.name}`);
    if (!this.auth) throw new Error('Secrets backend unavailable, so a sign-in cannot be stored.');
    const p = def.provider;
    return this.auth.beginLoginWith(
      {
        connectorId: connector.id,
        connectorName: connector.name,
        clientKey: p.key,
        authorizationEndpoint: p.authorizationEndpoint,
        tokenEndpoint: p.tokenEndpoint,
        scopes: def.scopes,
        extras: p.authorizeExtras,
        providerName: p.displayName,
      },
      opts,
    );
  }
}
