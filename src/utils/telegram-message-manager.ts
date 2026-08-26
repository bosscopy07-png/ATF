import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';

interface UserMessageState {
  chatId: number;
  messageId?: number;
}

const userStates = new Map<number, UserMessageState>();

export class TelegramMessageManager {
  private bot: TelegramBot;

  constructor(bot: TelegramBot) {
    this.bot = bot;
  }

  private getState(userId: number): UserMessageState {
    if (!userStates.has(userId)) {
      userStates.set(userId, { chatId: 0 });
    }
    return userStates.get(userId)!;
  }

  private setMessageId(userId: number, messageId: number) {
    const state = this.getState(userId);
    state.messageId = messageId;
    userStates.set(userId, state);
  }

  private async deleteMessage(chatId: number, messageId: number): Promise<void> {
    try {
      await this.bot.deleteMessage(chatId, messageId);
    } catch {
      // Ignore deletion errors
    }
  }

  async deleteUserMessage(chatId: number, messageId: number): Promise<void> {
    await this.deleteMessage(chatId, messageId);
  }

  async showScreen(
    userId: number,
    chatId: number,
    caption: string,
    replyMarkup: TelegramBot.InlineKeyboardMarkup,
    options?: { parseMode?: TelegramBot.ParseMode }
  ): Promise<void> {
    const state = this.getState(userId);
    state.chatId = chatId;

    if (state.messageId) {
      try {
        // Try to edit existing message media + caption + keyboard
        await this.bot.editMessageMedia(
          {
            type: 'photo',
            media: config.botBrandingImageUrl,
            caption,
            parse_mode: options?.parseMode || 'HTML',
          },
          {
            chat_id: chatId,
            message_id: state.messageId,
            reply_markup: replyMarkup,
          }
        );
        return;
      } catch (editError) {
        // If edit fails, delete old and send new
        try {
          await this.deleteMessage(chatId, state.messageId);
        } catch {
          // ignore
        }
      }
    }

    // Send new photo message
    const sent = await this.bot.sendPhoto(chatId, config.botBrandingImageUrl, {
      caption,
      parse_mode: options?.parseMode || 'HTML',
      reply_markup: replyMarkup,
    });

    this.setMessageId(userId, sent.message_id);
  }

  async showText(
    userId: number,
    chatId: number,
    text: string,
    replyMarkup?: TelegramBot.InlineKeyboardMarkup
  ): Promise<void> {
    const state = this.getState(userId);
    state.chatId = chatId;

    if (state.messageId) {
      try {
        await this.bot.editMessageCaption(text, {
          chat_id: chatId,
          message_id: state.messageId,
          reply_markup: replyMarkup,
          parse_mode: 'HTML',
        });
        return;
      } catch {
        try {
          await this.deleteMessage(chatId, state.messageId);
        } catch {
          // ignore
        }
      }
    }

    const sent = await this.bot.sendPhoto(chatId, config.botBrandingImageUrl, {
      caption: text,
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    });

    this.setMessageId(userId, sent.message_id);
  }

  async clearState(userId: number): Promise<void> {
    userStates.delete(userId);
  }
}
