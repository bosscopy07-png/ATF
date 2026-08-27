import express, { Request, Response } from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { config } from './config';
import { createAdminApp } from './admin';
import { setBot, handleStart, handleCallback, handleText } from './bot/handlers';

/**
 * Web Service
 * 
 * Responsibilities:
 * - Express HTTP server (health, admin dashboard, Telegram webhook)
 * - Telegram webhook handler (bot callbacks)
 * - Admin panel static + API routes
 * 
 * Does NOT run:
 * - Blockchain monitor (worker handles this)
 * - Reconciler loop (worker handles this)
 */

let botInstance: TelegramBot;

export async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json());

  // Initialize Telegram bot in webhook mode
  botInstance = new TelegramBot(config.telegramBotToken);
  setBot(botInstance);

  // Set webhook URL if running on Render
  const webhookBaseUrl = config.renderExternalUrl || `http://localhost:${config.port}`;
  const webhookPath = `/bot${config.telegramBotToken}`;
  const webhookUrl = `${webhookBaseUrl}${webhookPath}`;

  try {
    await botInstance.setWebHook(webhookUrl);
    console.log('Webhook set to:', webhookUrl);
  } catch (error) {
    console.error('Failed to set webhook:', error);
    // Continue anyway — can be set manually via curl
  }

  // Telegram webhook endpoint
  app.post(webhookPath, (req: Request, res: Response) => {
    botInstance.processUpdate(req.body);
    res.sendStatus(200);
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      mode: 'server',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      services: {
        database: 'connected',
        bot: 'webhook',
      },
    });
  });

  // Admin dashboard
  const adminApp = createAdminApp();
  app.use(adminApp);

  // Start HTTP server
  app.listen(config.port, () => {
    console.log(`Server listening on port ${config.port}`);
    console.log(`Admin dashboard: ${webhookBaseUrl}/admin`);
    console.log(`Health check: ${webhookBaseUrl}/health`);
  });

  // Bot event handlers
  botInstance.onText(/\/start/, async (msg) => {
    await handleStart(msg);
  });

  botInstance.on('callback_query', async (query) => {
    await handleCallback(query);
  });

  botInstance.on('message', async (msg) => {
    if (msg.text?.startsWith('/start')) return;
    await handleText(msg);
  });

  console.log('AFTSwap Web Service is operational');
}
