import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { setBot, handleStart, handleCallback, handleText, delUserMsg } from './handlers';
import { setDepositBot } from '../services/deposit-service';

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
  setDepositBot(bot);

  bot.on('message', (msg) => {
    if (msg.text === '/start') {
      handleStart(msg).finally(() => delUserMsg(msg));
    } else {
      // Delete the user's message AFTER handling (single-message chat hygiene)
      handleText(msg).finally(() => delUserMsg(msg));
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
