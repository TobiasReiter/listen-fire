import { prismaClient } from '../../prisma';
import { logger } from 'movement-engine/services/logger';
import { OviUser } from './types';
import { WhatsAppMessage } from '../../interfaces/whatsapp/webhook';
import { sendSlackNotification } from '../../lib/slack';
import { allEmoji } from './emoji';
import { isTeamMember } from './membership';
import { randomWord } from '../../lib/utils/randomWord';

const QUESTION_REGEX = /^secret question code: (\S+)\.(\S+)/;
const EMOJI_CODE_REGEX = /^secret question code:\s*(\S+)/;

async function findUserByPhoneNumber(phoneNumber: string): Promise<OviUser | null> {
  try {
    // Clean the phone number for consistent lookup
    const cleanedNumber = `+${cleanPhoneNumber(phoneNumber)}`;

    // Look for user with this phone number
    const userPhoneNumber = await prismaClient.phoneNumber.findUnique({
      where: {
        phoneNumber: cleanedNumber,
      },
    });

    if (!userPhoneNumber) {
      // Try alternative formats
      const alternativeFormats = getAlternativePhoneFormats(phoneNumber);

      for (const altFormat of alternativeFormats) {
        const altUserPhoneNumber = await prismaClient.phoneNumber.findUnique({
          where: {
            phoneNumber: altFormat,
          },
        });

        if (altUserPhoneNumber) {
          return {
            id: altUserPhoneNumber.id,
            name: altUserPhoneNumber.name,
          };
        }
      }

      return null;
    }

    return {
      id: userPhoneNumber.id,
      name: userPhoneNumber.name,
    };
  } catch (error: unknown) {
    logger.error('Error finding user by phone number:', error);
    return null;
  }
}

type WhatsappSender = {
  /** The owning Listen-Fire team, when the number is linked to a user — used to
   *  attribute the inbound-message ops event in the admin feed. */
  teamId: string | null;
  /** Best display name: the linked user's real name, else their username, else
   *  the label on the phone-number record. Null when nothing is known. */
  displayName: string | null;
};

/**
 * Resolve an inbound WhatsApp sender to their Listen-Fire team + a human display name.
 * Two reads, not a join: the number is this unit's own channel identity and the
 * person is core's (D3/D28). Prefers the user's real `name`, falling back to
 * `username`, then the phone-number label. Tolerant of the same alternative
 * number formats as `findUserByPhoneNumber`.
 *
 * The team is membership-confirmed, exactly as the dispatch door confirms it:
 * `default_team_id` is a preference and attributing a stranger's message to a
 * team they may not act in is the same mistake in a quieter place (C-6/D28).
 */
async function resolveWhatsappSender(phoneNumber: string): Promise<WhatsappSender> {
  const candidates = [
    `+${cleanPhoneNumber(phoneNumber)}`,
    ...getAlternativePhoneFormats(phoneNumber),
  ];

  for (const candidate of candidates) {
    try {
      const record = await prismaClient.phoneNumber.findUnique({
        where: { phoneNumber: candidate },
      });
      if (record) {
        const user = record.userId
          ? await prismaClient.user.findUnique({ where: { id: record.userId } })
          : null;
        const displayName = user?.name?.trim() || user?.username || record.name || null;
        const teamId =
          user && (await isTeamMember(user.id, user.defaultTeamId)) ? user.defaultTeamId : null;
        return { teamId, displayName };
      }
    } catch (error: unknown) {
      logger.error('Error resolving WhatsApp sender by phone number:', error);
      return { teamId: null, displayName: null };
    }
  }

  return { teamId: null, displayName: null };
}

function getAlternativePhoneFormats(phoneNumber: string): string[] {
  const cleaned = phoneNumber.replace(/\D/g, '');
  const formats: string[] = [];

  // Add the original cleaned number
  formats.push(cleaned);

  // If it's 11 digits starting with 1, try without the 1
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    formats.push(cleaned.substring(1));
  }

  // If it's 10 digits, try with 1 prefix
  if (cleaned.length === 10) {
    formats.push(`1${cleaned}`);
  }

  // Add with + prefix
  formats.push(`+${cleaned}`);

  return [...new Set(formats)]; // Remove duplicates
}

function cleanPhoneNumber(phoneNumber: string): string {
  // Remove all non-digit characters
  return phoneNumber.replace(/\D/g, '');
}

/**
 * Get emoji for position (1-5)
 */
function getEmojiForNumber(pos: number): string {
  switch (pos) {
    case 1:
      return '1️⃣';
    case 2:
      return '2️⃣';
    case 3:
      return '3️⃣';
    case 4:
      return '4️⃣';
    case 5:
      return '5️⃣';
    case 6:
      return '6️⃣';
    case 7:
      return '7️⃣';
    case 8:
      return '8️⃣';
    case 9:
      return '9️⃣';
    case 10:
      return '🔟';
    default:
      return `${pos}.`;
  }
}

function getRoutingString(message: WhatsAppMessage) {
  if (message.button?.payload) {
    return message.button.payload;
  }

  if (message.interactive?.button_reply?.id) {
    return message.interactive.button_reply.id;
  }

  if (message.interactive?.list_reply?.id) {
    return message.interactive.list_reply.id;
  }

  return null;
}

function parseRouting<T extends Record<string, string>>(route: string) {
  const url = new URL(route, 'ovi://');
  return {
    pathname: url.pathname.replace(/^\//, ''),
    searchParams: url.searchParams,
    params: Object.fromEntries(url.searchParams.entries()) as T,
    original: route,
  };
}

function getRouting<T extends Record<string, string> = Record<string, string>>(
  message: WhatsAppMessage,
) {
  const routingString = getRoutingString(message);
  if (!routingString) {
    return null;
  }
  return parseRouting<T>(routingString);
}

function queryParams(params: Record<string, string | undefined>) {
  const paramsCopy: Record<string, string> = {};
  Object.keys(params).forEach((key) => {
    if (params[key]) {
      paramsCopy[key] = params[key];
    }
  });
  return new URLSearchParams(paramsCopy).toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getContentFromMessage(message: WhatsAppMessage) {
  let content = '';
  if (message.text?.body) {
    content = message.text.body;
  } else if (message.button) {
    // Template button interaction
    content = `Button: ${message.button.text} (${message.button.payload})`;
  } else if (message.interactive?.button_reply) {
    // Interactive button interaction
    content = `Interactive Button: ${message.interactive.button_reply.title} (${message.interactive.button_reply.id})`;
  } else if (message.interactive?.list_reply) {
    content = `Interactive List: ${message.interactive.list_reply.title} (${message.interactive.list_reply.id})`;
  } else if (message.contacts && message.contacts.length > 0) {
    // Contact card message
    const contact = message.contacts[0];
    content = `Contact: ${contact.name.formatted_name}`;
    if (contact.org?.company) {
      content += ` @ ${contact.org.company}`;
    }
  }

  return content;
}

/** NOTE: only use this with pre-vetted strings. Unsafe encoded characters (like #) will break this for the web */
function whatsAppLink({ phoneNumber, text }: { phoneNumber: string; text: string }) {
  return `https://wa.me/${phoneNumber}?text=${text.replace(/ /g, '+')}`;
}

const slackAlerter = (path: string) => async (message: string, id: string) => {
  await sendSlackNotification({
    type: 'OVI',
    text: `🚨 [${path}][${id}] ${message}`,
    opsTitle: `WhatsApp error — ${message}`,
  });
};

// Generate emoji code from index
function generateEmojiCode2(idx: number) {
  // there are ~1123 emojis in our cleaned list
  // there are 55555 words we could generate from wordlist.txt
  // we need to use 2 emojis to represent each word uniquely
  // getting the remainder of the index by the length of the emoji list should give us access to all emoji
  // but to ensure a proper distribution of the first emoji
  // we use a factor of 40 (large but less than words/emojis) and another remainder to scale it
  return [
    allEmoji[Math.floor((idx * 40) / allEmoji.length) + (idx % 40)],
    allEmoji[idx % allEmoji.length],
  ];
}

async function getFreePhoneNumberCodes() {
  let identifier;
  let emojiCode;
  for (let i = 0; i < 10; i++) {
    const { word, index } = await randomWord();
    const existingPhoneNumber = await prismaClient.phoneNumber.findUnique({
      where: { wordIdentifier: word },
    });
    if (!existingPhoneNumber) {
      identifier = word;
      emojiCode = generateEmojiCode2(index).join('');
      break;
    }
  }

  if (!identifier) {
    return null;
  }

  return {
    identifier,
    emojiCode,
  };
}

async function getFreeCommunityQuestionCodes() {
  let identifier;
  let emojiCode;
  for (let i = 0; i < 10; i++) {
    const { word, index } = await randomWord();
    identifier = word;
    emojiCode = generateEmojiCode2(index).join('');
    break;
  }

  if (!identifier) {
    return null;
  }

  return {
    identifier,
    emojiCode,
  };
}

async function ensurePhoneNumberCodes(id: string) {
  let phoneNumber = await prismaClient.phoneNumber.findUnique({
    where: { id },
  });

  if (!phoneNumber) {
    return null;
  }

  if (!phoneNumber.wordIdentifier || !phoneNumber.emojiCode) {
    const codes = await getFreePhoneNumberCodes();
    if (!codes) {
      return null;
    }

    phoneNumber = await prismaClient.phoneNumber.update({
      where: { id },
      data: { wordIdentifier: codes.identifier, emojiCode: codes.emojiCode },
    });
  }

  return {
    wordIdentifier: phoneNumber.wordIdentifier!,
    emojiCode: phoneNumber.emojiCode!,
  };
}

async function ensureCommunityQuestionCodes(id: string): Promise<{ emojiCode: string } | null> {
  return null;
}

async function getQuestionAndReferrerFromCode(text: string) {
  let questionId: string | undefined = undefined;
  let referrerId: string | undefined = undefined;
  let remainingMessage: string | undefined = undefined;

  // First, try the old word identifier format
  const match = text.match(QUESTION_REGEX);
  const [_, questionTag, referrerTag] = match ?? [];

  if (questionTag) {
    const question = {
      id: '12345',
      question: 'What is your favorite color?',
      askedByPhoneNumberId: '12345',
    };
    if (question) {
      questionId = question.id;
    }

    if (referrerTag) {
      const referrer = await prismaClient.phoneNumber.findUnique({
        where: { wordIdentifier: referrerTag },
      });
      if (referrer && referrer.id !== question?.askedByPhoneNumberId) {
        referrerId = referrer.id;
      }
    }

    remainingMessage = text.replace(QUESTION_REGEX, '').trim();
  } else {
    // If word identifier format didn't match, try emoji code format
    const emojiMatch = text.match(EMOJI_CODE_REGEX);
    const emojiCode = emojiMatch?.[1]?.trim()?.split(' ')?.[0];

    if (emojiCode) {
      const emojiCodeParts = [...emojiCode];
      if (emojiCodeParts.length !== 4) {
        return {};
      }

      const referrerCode = [emojiCodeParts[2], emojiCodeParts[3]].join('');

      const question = {
        id: questionId,
        question: 'What is your favorite color?',
        askedByPhoneNumberId: '12345',
      };
      if (question) {
        questionId = question.id;
      }

      const referrer = await prismaClient.phoneNumber.findUnique({
        where: { emojiCode: referrerCode },
      });
      if (referrer && referrer.id !== question?.askedByPhoneNumberId) {
        referrerId = referrer.id;
      }

      remainingMessage = text.replace(EMOJI_CODE_REGEX, '').trim();
    }
  }
  return {
    questionId,
    referrerId,
    remainingMessage,
  };
}

/**
 * Convert standard markdown to WhatsApp-compatible formatting.
 * WhatsApp bold: *text*, italic: _text_, strikethrough: ~text~, mono: `text`
 */
function markdownToWhatsApp(text: string): string {
  const BOLD = '\u0001';

  // Bullet points first (before * gets reinterpreted)
  text = text.replace(/^[*+-] /gm, '• ');

  // Bold+italic: ***text*** → *_text_*
  text = text.replace(/\*{3}(.+?)\*{3}/g, `${BOLD}_$1_${BOLD}`);

  // Bold: **text** → marker
  text = text.replace(/\*{2}(.+?)\*{2}/g, `${BOLD}$1${BOLD}`);

  // Italic: remaining *text* → _text_
  text = text.replace(/\*(.+?)\*/g, '_$1_');

  // Restore bold markers → *text*
  text = text.replace(/\u0001/g, '*');

  // Strikethrough: ~~text~~ → ~text~
  text = text.replace(/~~(.+?)~~/g, '~$1~');

  // Headers → bold
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Links: [text](url) → text (url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  return text;
}

export {
  sleep,
  getEmojiForNumber,
  cleanPhoneNumber,
  findUserByPhoneNumber,
  resolveWhatsappSender,
  parseRouting,
  getRouting,
  getContentFromMessage,
  queryParams,
  QUESTION_REGEX,
  EMOJI_CODE_REGEX,
  whatsAppLink,
  slackAlerter,
  getFreeCommunityQuestionCodes,
  ensurePhoneNumberCodes,
  ensureCommunityQuestionCodes,
  getQuestionAndReferrerFromCode,
  markdownToWhatsApp,
};
