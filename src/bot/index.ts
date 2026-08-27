import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { setBot, handleStart, handleCallback, handleText } from './handlers';

let botInstance: TelegramBot;

export function getBotInstance(): TelegramBot {
  return botInstance;
}

export function setBotInstance(bot: TelegramBot): void {
  botInstance = bot;
}

export async function startBot(): Promise<void> {
  const bot = new TelegramBot(config.telegramBotToken, { polling: true });
  setBotInstance(bot);
  setBot(bot);

  bot.on('message', (msg) => {
    if (msg.text === '/start') {
      handleStart(msg);
    } else {
      handleText(msg);
    }
  });

  bot.on('callback_query', (query) => {
    handleCallback(query);
  });

  console.log('[Bot] Telegram bot started');
}

export async function stopBot(): Promise<void> {
  if (botInstance) {
    botInstance.stopPolling();
    console.log('[Bot] Telegram bot stopped');
  }
}

export { setBot, handleStart, handleCallback, handleText };
