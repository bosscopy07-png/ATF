import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import { config } from './config';
import { startBot, stopBot } from './bot';
import { createAdminApp } from './admin';
import { BlockchainMonitor } from './services/blockchain-monitor';
import { startReconciler, stopReconciler } from './jobs/reconciler';

// ─── Service Registry & Lifecycle ─────────────────────────────────────────

interface Service {
  name: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  health: () => Promise<{ status: 'healthy' | 'unhealthy'; details?: string }>;
}

class ServiceManager {
  private services: Service[] = [];
  private started = new Set<string>();
  private stopping = false;

  register(service: Service): void {
    this.services.push(service);
  }

  async startAll(): Promise<void> {
    for (const svc of this.services) {
      if (this.stopping) break;
      try {
        await svc.start();
        this.started.add(svc.name);
        console.log(`[ServiceManager] ${svc.name} started`);
      } catch (error) {
        console.error(`[ServiceManager] ${svc.name} failed to start:`, error);
        throw new Error(`Failed to start ${svc.name}: ${(error as Error).message}`);
      }
    }
  }

  async stopAll(timeoutMs = 30_000): Promise<void> {
    this.stopping = true;
    const deadline = Date.now() + timeoutMs;

    for (const svc of [...this.services].reverse()) {
      if (!this.started.has(svc.name)) continue;

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        console.warn(`[ServiceManager] Shutdown timeout reached, forcing exit`);
        break;
      }

      try {
        await Promise.race([
          svc.stop(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), remaining)
          ),
        ]);
        this.started.delete(svc.name);
        console.log(`[ServiceManager] ${svc.name} stopped`);
      } catch (error) {
        console.error(`[ServiceManager] ${svc.name} stop error:`, error);
      }
    }
  }

  async healthCheck(): Promise<Record<string, { status: string; details?: string }>> {
    const results: Record<string, { status: string; details?: string }> = {};
    await Promise.all(
      this.services.map(async (svc) => {
        if (!this.started.has(svc.name)) {
          results[svc.name] = { status: 'not_started' };
          return;
        }
        try {
          const h = await Promise.race([
            svc.health(),
            new Promise<{ status: 'unhealthy'; details: string }>((_, reject) =>
              setTimeout(() => reject(new Error('Health check timeout')), 5_000)
            ),
          ]);
          results[svc.name] = h;
        } catch {
          results[svc.name] = { status: 'unhealthy', details: 'Health check timed out' };
        }
      })
    );
    return results;
  }
}

// ─── Server Mode ───────────────────────────────────────────────────────────

async function startServer(): Promise<void> {
  const manager = new ServiceManager();
  let server: ReturnType<typeof app.listen> | null = null;

  // Bot service
  manager.register({
    name: 'telegram_bot',
    start: async () => startBot(),
    stop: async () => stopBot(),
    health: async () => ({ status: 'healthy' }), // Extend in bot module if needed
  });

  // HTTP service
  const app = express();
  const adminApp = createAdminApp();
  app.use(adminApp);

  app.get('/health', async (req: Request, res: Response) => {
    const services = await manager.healthCheck();
    const allHealthy = Object.values(services).every(
      (s) => s.status === 'healthy' || s.status === 'not_started'
    );

    res.status(allHealthy ? 200 : 503).json({
      status: allHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      version: config.version || '1.0.0',
      mode: 'server',
      services,
    });
  });

  // Readiness probe for K8s
  app.get('/ready', async (req: Request, res: Response) => {
    const services = await manager.healthCheck();
    const ready = Object.values(services).every((s) => s.status === 'healthy');
    res.status(ready ? 200 : 503).send(ready ? 'ok' : 'not ready');
  });

  // Liveness probe
  app.get('/live', (req: Request, res: Response) => {
    res.status(200).send('ok');
  });

  manager.register({
    name: 'http_server',
    start: async () => {
      await new Promise<void>((resolve, reject) => {
        server = app.listen(config.port, () => {
          console.log(`Admin dashboard on http://localhost:${config.port}/admin`);
          resolve();
        });
        server.on('error', reject);
      });
    },
    stop: async () => {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
    },
    health: async () => ({ status: 'healthy' }),
  });

  await manager.startAll();

  // Graceful shutdown
  setupShutdownHandlers(async (signal) => {
    console.log(`\n[Server] ${signal} received. Shutting down...`);
    await manager.stopAll(25_000);
    await mongoose.disconnect();
    console.log('[Server] MongoDB disconnected');
  });
}

// ─── Worker Mode ───────────────────────────────────────────────────────────

async function startWorker(): Promise<void> {
  const manager = new ServiceManager();

  const monitor = new BlockchainMonitor();
  manager.register({
    name: 'blockchain_monitor',
    start: async () => monitor.start(),
    stop: async () => monitor.stop(),
    health: async () => {
      // Extend BlockchainMonitor with isRunning() or similar
      return { status: 'healthy' };
    },
  });

  manager.register({
    name: 'reconciler',
    start: async () => startReconciler(),
    stop: async () => stopReconciler(),
    health: async () => ({ status: 'healthy' }),
  });

  await manager.startAll();

  // Workers should also expose a lightweight health endpoint or metrics
  // For now, log heartbeat
  setInterval(() => {
    console.log(`[Worker] Heartbeat — ${new Date().toISOString()}`);
  }, 60_000);

  setupShutdownHandlers(async (signal) => {
    console.log(`\n[Worker] ${signal} received. Shutting down...`);
    await manager.stopAll(25_000);
    await mongoose.disconnect();
    console.log('[Worker] MongoDB disconnected');
  });
}

// ─── Shutdown Utilities ────────────────────────────────────────────────────

function setupShutdownHandlers(shutdownFn: (signal: string) => Promise<void>): void {
  let shuttingDown = false;

  const handler = async (signal: string) => {
    if (shuttingDown) {
      console.log(`[Shutdown] Already shutting down, forcing exit...`);
      process.exit(1);
    }
    shuttingDown = true;

    // Force exit after absolute max timeout
    const forceExit = setTimeout(() => {
      console.error('[Shutdown] Forced exit after timeout');
      process.exit(1);
    }, 30_000);

    try {
      await shutdownFn(signal);
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      console.error('[Shutdown] Error during shutdown:', error);
      clearTimeout(forceExit);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));

  // Prevent unhandled errors from crashing immediately; let shutdown handler run
  process.on('uncaughtException', (error) => {
    console.error('[Fatal] Uncaught Exception:', error);
    handler('uncaughtException').catch(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('[Fatal] Unhandled Rejection at:', promise, 'reason:', reason);
  });
}

// ─── Main Bootstrap ────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  console.log('╔══════════════════════════════════════╗');
  console.log('║         AFTSwap v1.0.0               ║');
  console.log(`║   Mode: ${(config.appMode || 'server').toUpperCase().padEnd(26)} ║`);
  console.log('╚══════════════════════════════════════╝\n');

  // Validate critical config before starting
  if (!config.mongodbUri) {
    console.error('[Bootstrap] FATAL: MONGODB_URI is not set');
    process.exit(1);
  }

  // Connect MongoDB with retry logic
  let connected = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await mongoose.connect(config.mongodbUri);
      connected = true;
      console.log('[Bootstrap] MongoDB connected');
      break;
    } catch (error) {
      console.error(`[Bootstrap] MongoDB connection attempt ${attempt} failed:`, error);
      if (attempt === 3) {
        console.error('[Bootstrap] FATAL: Could not connect to MongoDB');
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }

  // Handle MongoDB disconnections at runtime
  mongoose.connection.on('disconnected', () => {
    console.error('[MongoDB] Connection lost');
  });
  mongoose.connection.on('reconnected', () => {
    console.log('[MongoDB] Reconnected');
  });

  try {
    if (config.appMode === 'worker') {
      await startWorker();
    } else {
      await startServer();
    }
    console.log('\n[AFTSwap] Operational');
  } catch (error) {
    console.error('[Bootstrap] Startup failed:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

bootstrap().catch((error) => {
  console.error('[Bootstrap] Unhandled bootstrap error:', error);
  process.exit(1);
});
        
