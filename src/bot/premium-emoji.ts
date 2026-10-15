/**
 * ATF NEXUS — Telegram Premium emoji layer.
 *
 * Scans outgoing message text/captions for emoji characters that have a
 * Telegram Premium custom-emoji equivalent and returns Bot API
 * MessageEntity[] of type "custom_emoji".
 *
 * Safety properties:
 *  - Pure function, no I/O, no logging of message content.
 *  - Returns [] when nothing matches → callers omit entities entirely,
 *    keeping requests identical to pre-upgrade behavior.
 *  - Offsets are UTF-16 code units, exactly what the Bot API requires.
 *  - Unmapped emoji stay as standard unicode (no breakage, no guessing).
 *
 * NOTE: custom_emoji entities are supported in message TEXT and CAPTIONS
 * only. InlineKeyboardButton text and answerCallbackQuery alerts cannot
 * carry entities — those keep unicode emoji by design.
 *
 * TYPING NOTE: the helpers below return the entities JSON-stringified
 * (typed `any`). node-telegram-bot-api's form encoder requires a string
 * at runtime; the raw MessageEntity[] is what buildPremiumEmojiEntities
 * produces and what the unit test validates.
 */

export interface PremiumEmojiEntity {
  type: 'custom_emoji';
  offset: number;
  length: number;
  custom_emoji_id: string;
}

/**
 * Emoji char → Telegram Premium custom_emoji_id.
 * IDs supplied by platform owner; add/replace here ONLY.
 */
export const PREMIUM_EMOJI_MAP: Record<string, string> = {
  '🎯': '5877235236416266965',
  '✨': '6131673419768403090',
  '🚀': '6131845772511024828',
  '👑': '6266995104687330978',
  '⭐': '6131878581766198553',
  '⭐️': '5291845148320214624',
  '😀': '6131660139729522939',
  '💎': '5384426402495893753',
  '⚡': '6132195567532512343',
  '🔔': '6264510702329797113',
  '◀️': '5440509136259267820',
  '➡️': '5436044822697750252',
  '🏠': '5416041192905265756',
  '💬': '6266794310671275367',
  '❌': '6131800692534285654',
  '🔄': '5264727218734524899',
  '🔼': '5041845079229072486',
  '🔽': '5042069744673358669',
  '✔️': '5039844895779455925',
  '✅': '6330245868284812606',
  '🌌': '5215394399738951801',
  '💸': '5864068125112144897',
  '💰': '5039789890133296083',
  '🏦': '5264895611517300926',
  '💳': '5269472852653912623',
  '📉': '6032767766119846056',
  '📊': '5884161133174067365',
  '🇳🇬': '5294456308047563965',
  '📤': '5433614747381538714',
  '📥': '5433811242135331842',
  '✈️': '6030595736733749484',
  '✈': '6030595736733749484',
  '⌛': '5386367538735104399',
  '📸': '5857198045749317597',
  '🔗': '5859270552153231910',
  '🧾': '5444856076954520455',
  '🔜': '5440621591387980068',
  '🔶': '5938168246682259511',
  '🤑': '5226745323992414666',
  '💼': '5359785904535774578',
  '📲': '6026092115631543342',
  '📶': '6089079919856325971',
  '📺': '5373330964372004748',
  '💡': '5422439311196834318',
  '💧': '5393512611968995988',
  '🎁': '6217489739675604129',
  '🗃': '5263015519648249817',
  '🎵': '5929546997483704366',
  '🔍': '5258274739041883702',
  '🎮': '5233505611106251865',
  '🎬': '5375464961822695044',
  '▶️': '5039937555403899813',
  '🛩': '6023974774064026637',
  '👷‍♀️': '5298563190135733523',
  '🛫': '6276248500057413207',
  '📌': '5039600026809009149',
  '🗓': '5413879192267805083',
  '🛍': '5039730920232322000',
  '🏆': '5462927083132970373',
  '🥇': '5440539497383087970',
  '👥': '5453957997418004470',
  '🪙': '5381975814415866082',
  '🎉': '5989848973974704652',
  '🛡️': '5042328396193864923',
  '🛡': '5042328396193864923',
  '🔒': '5269257919605516540',
  '🔓': '5429405838345265327',
  '🔑': '5454386656628991407',
  '🪪': '6030753228889526497',
  '💪': '6305232116191861088',
  '👍': '6273898633255458821',
  '⚙️': '5298572699193325446',
  '⚠️': '6305575331323450417',
  '🔈': '6303121637982082284',
  '🌐': '5042186567783809934',
  '🔖': '5039826874096681939',
  '❓': '6132015934820324637',
  '✉️': '6305110637336860697',
  '📬': '5350421256627838238',
  '🐛': '5314507981344220324',
};

// Longest keys first so "⭐️" wins over "⭐", "✈️" over "✈", etc.
const PATTERN = new RegExp(
  Object.keys(PREMIUM_EMOJI_MAP)
    .sort((a, b) => b.length - a.length)
    .map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'gu'
);

/**
 * Build custom_emoji entities for a text/caption.
 * Returns a NEW sorted, non-overlapping array (safe to pass to Bot API).
 */
export function buildPremiumEmojiEntities(
  text: string
): PremiumEmojiEntity[] {
  if (!text) return [];

  const entities: PremiumEmojiEntity[] = [];
  for (const match of text.matchAll(PATTERN)) {
    const emoji = match[0];
    const id = PREMIUM_EMOJI_MAP[emoji];
    if (!id) continue;
    entities.push({
      type: 'custom_emoji',
      offset: match.index,        // UTF-16 code units (Bot API spec)
      length: emoji.length,       // UTF-16 code units
      custom_emoji_id: id,
    });
  }
  return entities;
}

/**
 * Convenience for Bot API options. Returns the entities JSON-stringified
 * — node-telegram-bot-api's multipart form encoder requires a string;
 * passing a raw array silently drops the field.
 *
 * `any` is deliberate: Bot API typings declare MessageEntity[], the
 * runtime wants string. Callers spread the result into send options.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function premiumEmojiOptions(text: string): any {
  const entities = buildPremiumEmojiEntities(text);
  return entities.length ? { entities: JSON.stringify(entities) } : {};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function premiumEmojiCaptionOptions(text: string): any {
  const entities = buildPremiumEmojiEntities(text);
  return entities.length ? { caption_entities: JSON.stringify(entities) } : {};
  }
  
