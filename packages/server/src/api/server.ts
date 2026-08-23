import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { createApp, drainMailbox, type App } from '../app.js';
import { registerCoreRoutes } from './routes-core.js';
import { registerOpsRoutes } from './routes-ops.js';
import { logger } from '../util/log.js';
import { LIMITS } from '@antbot/shared';

const log = logger('server');

export interface StartOptions {
  root?: string;
  port?: number;
  host?: string;
  withAgent?: boolean;
  serveStatic?: boolean;
}

export interface RunningServer {
  fastify: FastifyInstance;
  app: App;
  url: string;
  close: () => Promise<void>;
}

function findWebDist(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../../web/dist'),
    path.resolve(here, '../../../../packages/web/dist'),
    path.resolve(process.cwd(), 'packages/web/dist'),
  ];
  return candidates.find((c) => fs.existsSync(path.join(c, 'index.html'))) ?? null;
}

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const app = await createApp({ root: opts.root, withAgent: opts.withAgent });
  const fastify = Fastify({ logger: false, bodyLimit: LIMITS.MAX_VIDEO_ATTACHMENT_BYTES });

  // Several endpoints are pure commands with no payload (stop, duplicate, read,
  // test-run). Fastify rejects a zero-length body when the client still sends
  // `content-type: application/json` — and it does so before any content-type
  // parser runs — so drop the header for genuinely empty requests.
  fastify.addHook('onRequest', (req, _reply, done) => {
    const len = req.headers['content-length'];
    const ct = req.headers['content-type'];
    if ((len === '0' || len === undefined) && ct?.includes('application/json')) {
      delete req.headers['content-type'];
    }
    done();
  });

  await fastify.register(cors, { origin: true });
  await fastify.register(multipart, {
    limits: { fileSize: LIMITS.MAX_VIDEO_ATTACHMENT_BYTES, files: LIMITS.MAX_ATTACHMENTS_PER_MESSAGE },
  });
  await fastify.register(websocket);

  registerCoreRoutes(fastify, app);
  registerOpsRoutes(fastify, app);

  /* ------------------------- event websocket ------------------------- */
  fastify.register(async (scope) => {
    scope.get('/api/events', { websocket: true }, (socket) => {
      const send = (payload: unknown): void => {
        try {
          if (socket.readyState === 1) socket.send(JSON.stringify(payload));
        } catch { /* client vanished */ }
      };
      const unsubscribe = app.bus.subscribe(send);
      // Handshake only — carries the current seq so the client can detect gaps.
      // Deliberately not a `notify`: connection state is UI chrome, not a user alert.
      send({ type: 'hello', seq: app.bus.currentSeq, threadId: null, botId: null });

      socket.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type?: string; seq?: number };
          if (msg.type === 'resume' && typeof msg.seq === 'number')
            for (const e of app.bus.since(msg.seq)) send(e);
        } catch { /* ignore malformed client frames */ }
      });
      socket.on('close', unsubscribe);
      socket.on('error', unsubscribe);
    });

    /* --------------------------- screencast -------------------------- */
    scope.get<{ Params: { botId: string } }>('/api/computer/screencast/:botId', { websocket: true }, async (socket, req) => {
      const botId = req.params.botId;
      if (!app.browser?.startScreencast) {
        try { socket.send(JSON.stringify({ type: 'error', message: 'Browser service unavailable' })); } catch { /* ignore */ }
        socket.close();
        return;
      }
      let stop: (() => void) | undefined;
      try {
        stop = await app.browser.startScreencast(botId, (data: string, w: number, h: number) => {
          try {
            if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'frame', data, w, h }));
          } catch { /* ignore */ }
        });
      } catch (err) {
        try { socket.send(JSON.stringify({ type: 'error', message: (err as Error).message })); } catch { /* ignore */ }
        socket.close();
        return;
      }
      socket.on('close', () => stop?.());
      socket.on('error', () => stop?.());
    });
  });

  /* ---------------------------- static UI ---------------------------- */
  if (opts.serveStatic !== false) {
    const dist = findWebDist();
    if (dist) {
      await fastify.register(fastifyStatic, { root: dist, prefix: '/' });
      fastify.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api')) return reply.code(404).send({ error: 'Not found' });
        return reply.sendFile('index.html');
      });
      log.info(`serving UI from ${dist}`);
    } else {
      log.warn('web UI not built — run `pnpm --filter @antbot/web build`');
      fastify.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api')) return reply.code(404).send({ error: 'Not found' });
        return reply.type('text/html').send(
          `<!doctype html><meta charset=utf-8><title>ant-bot</title>
           <body style="font-family:system-ui;background:#0b0d10;color:#e6e8eb;padding:3rem">
           <h1>ant-bot daemon is running</h1>
           <p>The web UI has not been built yet. Run:</p>
           <pre style="background:#151922;padding:1rem;border-radius:8px">pnpm --filter @antbot/web build</pre>
           <p>The API is live at <code>/api/health</code>.</p>`,
        );
      });
    }
  }

  fastify.setErrorHandler((err: unknown, _req, reply) => {
    log.error('request failed', err);
    const e = err as { statusCode?: number; message?: string };
    const code = e.statusCode && e.statusCode >= 400 ? e.statusCode : 500;
    reply.code(code).send({ error: e.message ?? 'Internal error' });
  });

  const port = opts.port ?? app.cfg.port;
  const host = opts.host ?? app.cfg.host;
  await fastify.listen({ port, host });
  const url = `http://${host}:${port}`;

  const delivered = drainMailbox(app);
  if (delivered) log.info(`redelivered ${delivered} queued handoff message(s)`);

  // Mark any turn that was mid-flight when the daemon died as interrupted.
  const stale = app.store.listBots().filter((b) => b.state === 'running' || b.state === 'queued');
  for (const b of stale) app.store.updateBot(b.id, { state: 'idle' });
  app.db.prepare(`UPDATE messages SET streaming=0 WHERE streaming=1`).run();
  app.db.prepare(`UPDATE approvals SET status='expired', reason='Daemon restarted' WHERE status='pending'`).run();
  app.db.prepare(`UPDATE routine_runs SET status='interrupted', finished_at=? WHERE status='running'`).run(Date.now());

  log.info(`ant-bot listening on ${url}`);

  return {
    fastify,
    app,
    url,
    close: async () => {
      await fastify.close();
      await app.shutdown();
    },
  };
}
