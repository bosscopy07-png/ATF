import TelegramBot from 'node-telegram-bot-api';
import { setBot, handleStart, handleCallback, handleText } from './handlers';

let botInstance: TelegramBot;

export function getBotInstance(): TelegramBot {
  return botInstance;
}

export function setBotInstance(bot: TelegramBot): void {
  botInstance = bot;
}

export { setBot, handleStart, handleCallback, handleText };
