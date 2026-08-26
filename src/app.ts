import express from 'express';
import mongoose from 'mongoose';
import { config } from './config';
import { startBot } from './bot';
import { createAdminApp } from './admin';
import { BlockchainMonitor } from './services/blockchain-monitor';
import { startReconciler } from './jobs/reconciler';

async function bootstrap(): Promise<void> {
  console.log('╔══════════════════════════════════════╗');
  console.log('║         AFTSwap v1.0.0               ║');
  console.log('║   TON ↔ AFT Custodial Exchange     ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  try {
    await mongoose.connect(config.mongodbUri);
    console.log('Connected to MongoDB');
  } catch (error) {
    console.error('MongoDB connection failed:', error);
    process.exit(1);
  }

  try {
    await startBot();
    console.log('Telegram bot started');
  } catch (error) {
    console.error('Telegram bot failed to start:', error);
    process.exit(1);
  }

  const monitor = new BlockchainMonitor();
  monitor.start();
  console.log('Blockchain monitor started');

  try {
    await startReconciler();
    console.log('Background reconciler started');
  } catch (error) {
    console.error('Reconciler failed to start:', error);
  }

  const app = express();
  const adminApp = createAdminApp();
  app.use(adminApp);

  app.listen(config.port, () => {
    console.log(`Admin dashboard running on http://localhost:${config.port}/admin`);
  });

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      services: {
        database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        bot: 'running',
        monitor: 'running',
      },
    });
  });

  const gracefulShutdown = async (signal: string) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    await mongoose.disconnect();
    console.log('MongoDB disconnected');
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    setTimeout(() => process.exit(1), 5000);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });

  console.log('');
  console.log('AFTSwap is operational');
}

bootstrap().catch((error) => {
  console.error('Bootstrap failed:', error);
  process.exit(1);
});
