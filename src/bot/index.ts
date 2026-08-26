import TelegramBot from 'node-telegram-bot-api';
import mongoose from 'mongoose';
import { config } from '../config';
import { setBot, handleStart, handleCallback, handleText } from './handlers';

export async function startBot(): Promise<void> {
  // Connect to MongoDB
  await mongoose.connect(config.mongodbUri);
  console.log('Connected to MongoDB');

  const bot = new TelegramBot(config.telegramBotToken, { polling: true });
  setBot(bot);

  // /start command
  bot.onText(/\/start/, async (msg) => {
    await handleStart(msg);
  });

  // Callback queries
  bot.on('callback_query', async (query) => {
    await handleCallback(query);
  });

  // Text messages (excluding /start)
  bot.on('message', async (msg) => {
    if (msg.text?.startsWith('/start')) return;
    await handleText(msg);
  });

  console.log('AFTSwap bot started');
}
