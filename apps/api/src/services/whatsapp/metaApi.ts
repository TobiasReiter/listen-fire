import axios from 'axios';
import FormData from 'form-data';
import * as ExcelJS from 'exceljs';

import { logger } from 'movement-engine/public/log';
import { getEnvVar } from '../../lib/utils/environment';
import { buildOtpTemplatePayload } from './phone_verification/otp_template';

/** The authentication template that delivers verification codes (copy-code
 *  button). Authored in Meta by the operator; hardcoded here for now. */
const VERIFY_OTP_TEMPLATE_NAME = 'verify_otp';
const VERIFY_OTP_LANGUAGE = 'en_US';

// Interactive message type definitions
type ButtonMessage = {
  header?: string;
  body: string;
  footer?: string;
  buttons: Array<{
    id: string;
    title: string;
  }>;
};

type ListMessage = {
  header?: string;
  body: string;
  footer?: string;
  buttonText: string;
  sections: Array<{
    title?: string;
    rows: Array<{
      id: string;
      title: string;
      description?: string;
    }>;
  }>;
};

interface ReplyButtonMessage {
  body: string;
  buttons: Array<{
    id: string;
    title: string;
  }>;
}

interface CTAURLButtonMessage {
  header?: string;
  footer?: string;
  body: string;
  button: {
    url: string;
    title: string;
  };
}

interface InteractiveMessagePayload {
  messaging_product: string;
  to: string;
  type: string;
  interactive: {
    type: string;
    header?: {
      type: string;
      text: string;
    };
    body: {
      text: string;
    };
    footer?: {
      text: string;
    };
    action: {
      name?: string;
      parameters?: {
        display_text: string;
        url: string;
      };
      button?: string;
      buttons?: Array<{
        type: string;
        reply: {
          id: string;
          title: string;
        };
      }>;
      sections?: Array<{
        title?: string;
        rows: Array<{
          id: string;
          title: string;
          description?: string;
        }>;
      }>;
    };
  };
}

interface WhatsAppApiTemplate {
  id: string;
  name: string;
  category:
    | 'ACCOUNT_UPDATE'
    | 'PAYMENT_UPDATE'
    | 'PERSONAL_FINANCE_UPDATE'
    | 'SHIPPING_UPDATE'
    | 'RESERVATION_UPDATE'
    | 'ISSUE_RESOLUTION'
    | 'APPOINTMENT_UPDATE'
    | 'TRANSPORTATION_UPDATE'
    | 'TICKET_UPDATE'
    | 'ALERT_UPDATE'
    | 'AUTO_REPLY'
    | 'TRANSACTIONAL'
    | 'OTP'
    | 'UTILITY'
    | 'MARKETING'
    | 'AUTHENTICATION';
  parameter_format: 'POSITIONAL' | 'NAMED';
  language: string;
  status:
    | 'APPROVED'
    | 'IN_APPEAL'
    | 'PENDING'
    | 'REJECTED'
    | 'PENDING_DELETION'
    | 'DELETED'
    | 'DISABLED'
    | 'PAUSED'
    | 'LIMIT_EXCEEDED'
    | 'ARCHIVED';
  components: Array<
    | {
        type: 'BODY';
        text: string;
        example: {
          body_text: [Array<string>];
        };
      }
    | {
        type: 'BUTTONS';
        buttons: Array<{
          type: 'QUICK_REPLY';
          text: string;
        }>;
      }
    | {
        type: 'HEADER';
        format: 'TEXT';
        text: string;
      }
    | {
        type: 'FOOTER';
        text: string;
      }
  >;
}

interface WhatsAppTemplateDetails {
  id: string;
  name: string;
  body: string;
  variables: string[];
  language: string;
}

/**
 * Base of the Meta Graph API, version segment included. Defaults to the live
 * host; overridable via `WHATSAPP_GRAPH_BASE_URL` so the dev loop can point
 * media download / send / template traffic at the fake Meta Cloud API
 * (`apps/fake-channels`) and prove the inbound-media path end-to-end without a
 * real Graph token. See docs/dev-loop.md ("fake Meta media").
 */
function graphBaseUrl(): string {
  return process.env.WHATSAPP_GRAPH_BASE_URL || 'https://graph.facebook.com/v19.0';
}

/** The credentials one Meta WhatsApp NUMBER sends with. Explicit so the service
 *  is no longer hardwired to a single env number — the registry below builds one
 *  instance per configured number (primary + movements). */
export interface WhatsappNumberCreds {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId?: string;
}

class MetaWhatsAppApiService {
  private readonly accessToken: string;
  private readonly phoneNumberId: string;
  private readonly graphBase: string;
  private readonly baseUrl: string;
  private readonly businessAccountId: string;

  constructor(creds: WhatsappNumberCreds) {
    this.accessToken = creds.accessToken;
    this.phoneNumberId = creds.phoneNumberId;
    this.businessAccountId = creds.businessAccountId ?? '';
    this.graphBase = graphBaseUrl();
    this.baseUrl = `${this.graphBase}/${this.phoneNumberId}/messages`;
  }

  /** The Meta phone number id this instance sends from — the registry key. */
  get numberId(): string {
    return this.phoneNumberId;
  }

  /**
   * Send type on message
   */
  /** Mark an inbound message read — the blue-tick receipt, no typing
   *  indicator. Fire-and-forget from the inbound dispatcher. */
  async markMessageRead(waMessageId: string): Promise<boolean> {
    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          message_id: waMessageId,
          status: 'read',
        }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error('Meta WhatsApp API read-receipt error:', { error: errorData });
        return false;
      }
      return true;
    } catch (error: unknown) {
      logger.error('Failed to mark WhatsApp message read:', error);
      return false;
    }
  }

  async sendTypingOn(waMessageId: string): Promise<boolean> {
    try {
      const payload = {
        messaging_product: 'whatsapp',
        message_id: waMessageId,
        status: 'read',
        typing_indicator: {
          type: 'text',
        },
      };

      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error('Meta WhatsApp API Error:', { error: errorData });
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return true;
    } catch (error: unknown) {
      logger.error('Failed to send typing on via Meta WhatsApp API:', error);
      return false;
    }
  }

  async sendReaction(to: string, waMessageId: string, emoji: string): Promise<boolean> {
    try {
      const payload = {
        messaging_product: 'whatsapp',
        to: this.formatPhoneNumber(to),
        type: 'reaction',
        reaction: {
          message_id: waMessageId,
          emoji,
        },
      };

      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error('Meta WhatsApp API reaction error:', { error: errorData });
        return false;
      }

      return true;
    } catch (error: unknown) {
      logger.error('Failed to send reaction via Meta WhatsApp API:', error);
      return false;
    }
  }

  /**
   * Send a text message via WhatsApp Business API (Meta Cloud API)
   */
  async sendTextMessage(
    to: string,
    message: string,
    options: { replyToMessageId?: string } = {},
  ): Promise<string | null> {
    try {
      const payload = {
        messaging_product: 'whatsapp',
        to: this.formatPhoneNumber(to),
        type: 'text',
        text: {
          preview_url: true,
          body: message,
        },
        // Threads the send as a reply — WhatsApp renders it quoting the
        // referenced message.
        ...(options.replyToMessageId !== undefined
          ? { context: { message_id: options.replyToMessageId } }
          : {}),
      };

      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error('Meta WhatsApp API Error:', {
          status: response.status,
          statusText: response.statusText,
          error: errorData,
        });
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const responseData = await response.json();

      if (!responseData.messages || !responseData.messages[0]?.id) {
        logger.error('Invalid response from Meta WhatsApp API:', responseData);
        throw new Error('Failed to send message - invalid response');
      }

      const messageId = responseData.messages[0].id;
      logger.info('Message sent successfully via Meta WhatsApp API:', {
        messageId,
        to: this.formatPhoneNumber(to),
      });

      return messageId;
    } catch (error: unknown) {
      logger.error('Failed to send message via Meta WhatsApp API:', error);
      throw new Error('Failed to send message');
    }
  }

  /**
   * Send an interactive button message via WhatsApp Business API
   * Supports up to 3 action buttons
   */
  async sendButtonMessage(to: string, buttonMessage: ButtonMessage): Promise<string | null> {
    try {
      // Validate button count (max 3 buttons)
      if (buttonMessage.buttons.length > 3) {
        throw new Error('Button messages support maximum 3 buttons');
      }

      // Validate button titles (max 20 characters each)
      for (const button of buttonMessage.buttons) {
        if (button.title.length > 20) {
          throw new Error(`Button title "${button.title}" exceeds 20 character limit`);
        }
      }

      const payload = {
        messaging_product: 'whatsapp',
        to: this.formatPhoneNumber(to),
        type: 'interactive',
        interactive: {
          type: 'button',
          ...(buttonMessage.header && { header: { type: 'text', text: buttonMessage.header } }),
          body: { text: buttonMessage.body },
          ...(buttonMessage.footer && { footer: { text: buttonMessage.footer } }),
          action: {
            buttons: buttonMessage.buttons.map((button) => ({
              type: 'reply',
              reply: {
                id: button.id,
                title: button.title,
              },
            })),
          },
        },
      };

      return await this.sendInteractiveMessage(payload, to, 'button');
    } catch (error: unknown) {
      logger.error('Failed to send button message via Meta WhatsApp API:', error);
      throw new Error('Failed to send button message');
    }
  }

  async sendCTAURLButtonMessage(to: string, message: CTAURLButtonMessage): Promise<string | null> {
    try {
      const payload = {
        messaging_product: 'whatsapp',
        to: this.formatPhoneNumber(to),
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          ...(message.header && { header: { type: 'text', text: message.header } }),
          body: { text: message.body },
          ...(message.footer && { footer: { text: message.footer } }),
          action: {
            name: 'cta_url',
            parameters: {
              display_text: message.button.title,
              url: message.button.url,
            },
          },
        },
      };

      return await this.sendInteractiveMessage(payload, to, 'button');
    } catch (error: unknown) {
      logger.error('Failed to send button message via Meta WhatsApp API:', error);
      throw new Error('Failed to send button message');
    }
  }

  /**
   * Send an interactive list message via WhatsApp Business API
   * Supports multiple sections with selectable rows
   */
  async sendListMessage(to: string, listMessage: ListMessage): Promise<string | null> {
    try {
      // Validate sections and rows
      if (listMessage.sections.length === 0) {
        throw new Error('List message must have at least one section');
      }

      const totalRows = listMessage.sections.reduce((sum, section) => sum + section.rows.length, 0);
      if (totalRows > 10) {
        throw new Error('List messages support maximum 10 rows across all sections');
      }

      // Validate button text length (max 20 characters)
      if (listMessage.buttonText.length > 20) {
        throw new Error('List button text exceeds 20 character limit');
      }

      const payload = {
        messaging_product: 'whatsapp',
        to: this.formatPhoneNumber(to),
        type: 'interactive',
        interactive: {
          type: 'list',
          ...(listMessage.header && { header: { type: 'text', text: listMessage.header } }),
          body: { text: listMessage.body },
          ...(listMessage.footer && { footer: { text: listMessage.footer } }),
          action: {
            button: listMessage.buttonText,
            sections: listMessage.sections.map((section) => ({
              ...(section.title && { title: section.title }),
              rows: section.rows.map((row) => ({
                id: row.id,
                title: row.title,
                ...(row.description && { description: row.description }),
              })),
            })),
          },
        },
      };

      return await this.sendInteractiveMessage(payload, to, 'list');
    } catch (error: unknown) {
      logger.error('Failed to send list message via Meta WhatsApp API:', error);
      throw new Error('Failed to send list message');
    }
  }

  /**
   * Send an interactive reply button message via WhatsApp Business API
   * Supports up to 3 quick reply buttons
   */
  async sendReplyButtonMessage(
    to: string,
    replyMessage: ReplyButtonMessage,
  ): Promise<string | null> {
    try {
      // Validate button count (max 3 buttons)
      if (replyMessage.buttons.length > 3) {
        throw new Error('Reply button messages support maximum 3 buttons');
      }

      // Validate button titles (max 20 characters each)
      for (const button of replyMessage.buttons) {
        if (button.title.length > 20) {
          throw new Error(`Button title "${button.title}" exceeds 20 character limit`);
        }
      }

      const payload = {
        messaging_product: 'whatsapp',
        to: this.formatPhoneNumber(to),
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: replyMessage.body },
          action: {
            buttons: replyMessage.buttons.map((button) => ({
              type: 'reply',
              reply: {
                id: button.id,
                title: button.title,
              },
            })),
          },
        },
      };

      return await this.sendInteractiveMessage(payload, to, 'reply_button');
    } catch (error: unknown) {
      logger.error('Failed to send reply button message via Meta WhatsApp API:', error);
      throw new Error('Failed to send reply button message');
    }
  }

  /**
   * Send an interactive message with a caller-supplied `interactive` object,
   * passed through VERBATIM — no reshaping, no typed button/list wrapper (the
   * verbatim-passthrough doctrine: matches Telegram's `reply_markup`). The
   * caller owns the WhatsApp Cloud API shape completely; a malformed object
   * surfaces as a loud Meta API error at send time, never a save-time check.
   */
  async sendInteractive(
    to: string,
    interactive: unknown,
    options: { replyToMessageId?: string } = {},
  ): Promise<string | null> {
    try {
      const payload = {
        messaging_product: 'whatsapp',
        to: this.formatPhoneNumber(to),
        type: 'interactive',
        interactive,
        ...(options.replyToMessageId !== undefined
          ? { context: { message_id: options.replyToMessageId } }
          : {}),
      };

      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error('Meta WhatsApp API interactive-send error:', { error: errorData });
        return null;
      }

      const responseData = await response.json();
      const messageId = responseData.messages?.[0]?.id ?? null;
      if (!messageId) {
        logger.error('Invalid response from Meta WhatsApp API:', responseData);
        return null;
      }
      return messageId;
    } catch (error: unknown) {
      logger.error('Failed to send interactive message via Meta WhatsApp API:', error);
      return null;
    }
  }

  /**
   * Normalise a template parameter by removing extra whitespace and newlines
   * WhatsApp {{n}} parameters don't support newlines, tabs or more than 4 consecutive spaces
   */
  normaliseTemplateParameter(question: string) {
    let current,
      replacement = question.trim();
    while (current !== replacement) {
      current = replacement;
      replacement = current.replace(/(\n| {4,}|\t)/g, ' ');
    }
    return replacement;
  }

  /**
   * Send a template message via WhatsApp Business API
   * Supports templates with quick reply buttons and parameter substitution
   */
  async sendTemplateMessage({
    to,
    templateName,
    languageCode = 'en_US',
    parameters,
    headerParameters,
    buttons,
  }: {
    to: string;
    templateName: string;
    languageCode: string;
    parameters?: string[];
    headerParameters?: string[];
    buttons?: {
      id: string;
    }[];
  }): Promise<string | null> {
    try {
      // Validate template name
      if (!templateName || templateName.trim().length === 0) {
        throw new Error('Template name is required');
      }

      // Build template components for parameters
      const components: Array<{
        type: string;
        sub_type?: string;
        index?: string;
        parameters: Array<{
          type: string;
          text: string;
        }>;
      }> = [];

      if (parameters && parameters.length > 0) {
        components.push({
          type: 'body',
          parameters: parameters.map((param) => ({
            type: 'text',
            text: this.normaliseTemplateParameter(param),
          })),
        });
      }

      if (headerParameters && headerParameters.length > 0) {
        components.push({
          type: 'header',
          parameters: headerParameters.map((param) => ({
            type: 'text',
            text: this.normaliseTemplateParameter(param),
          })),
        });
      }

      if (buttons?.length) {
        for (let i = 0; i < buttons.length; i++) {
          const button = buttons[i];
          components.push({
            type: 'button',
            sub_type: 'quick_reply',
            index: i.toString(),
            parameters: [
              {
                type: 'text',
                text: button.id,
              },
            ],
          });
        }
      }

      const payload = {
        messaging_product: 'whatsapp',
        to: this.formatPhoneNumber(to),
        type: 'template',
        template: {
          name: templateName,
          language: {
            code: languageCode,
          },
          ...(components.length > 0 && { components }),
        },
      };

      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error('Meta WhatsApp Template API Error:', {
          status: response.status,
          statusText: response.statusText,
          error: errorData,
          templateName,
          languageCode,
        });
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const responseData = await response.json();

      if (!responseData.messages || !responseData.messages[0]?.id) {
        logger.error('Invalid template message response from Meta WhatsApp API:', responseData);
        throw new Error('Failed to send template message - invalid response');
      }

      const messageId = responseData.messages[0].id;
      logger.info('Template message sent successfully via Meta WhatsApp API:', {
        messageId,
        templateName,
        languageCode,
        parameterCount: parameters?.length || 0,
        to: this.formatPhoneNumber(to),
      });

      return messageId;
    } catch (error: unknown) {
      logger.error('Failed to send template message via Meta WhatsApp API:', error);
      throw new Error('Failed to send template message');
    }
  }

  /**
   * Send a one-time verification code via the `verify_otp` authentication
   * template (copy-code button). The code rides both the body parameter and the
   * button parameter, as Meta requires for OTP templates. Returns the Meta
   * message id; throws on a non-OK response so the caller can surface failure.
   */
  async sendVerificationOtp({ to, code }: { to: string; code: string }): Promise<string | null> {
    const payload = buildOtpTemplatePayload({
      to: this.formatPhoneNumber(to),
      code,
      templateName: VERIFY_OTP_TEMPLATE_NAME,
      languageCode: VERIFY_OTP_LANGUAGE,
    });

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      logger.error('Meta WhatsApp OTP template send failed', {
        status: response.status,
        error: errorData,
      });
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const messageId = data.messages?.[0]?.id ?? null;
    logger.info('Sent WhatsApp verification code', { to: this.formatPhoneNumber(to), messageId });
    return messageId;
  }

  /**
   * Common method to send interactive messages
   */
  private async sendInteractiveMessage(
    payload: InteractiveMessagePayload,
    to: string,
    messageType: string,
  ): Promise<string | null> {
    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error('Meta WhatsApp API Error:', {
          status: response.status,
          statusText: response.statusText,
          error: errorData,
          messageType,
        });
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const responseData = await response.json();

      if (!responseData.messages || !responseData.messages[0]?.id) {
        logger.error('Invalid response from Meta WhatsApp API:', responseData);
        throw new Error('Failed to send interactive message - invalid response');
      }

      const messageId = responseData.messages[0].id;
      logger.info('Interactive message sent successfully via Meta WhatsApp API:', {
        messageId,
        messageType,
        to: this.formatPhoneNumber(to),
      });

      return messageId;
    } catch (error: unknown) {
      logger.error(`Failed to send ${messageType} message via Meta WhatsApp API:`, error);
      throw error;
    }
  }

  /**
   * Download inbound media from WhatsApp by media ID
   */
  async downloadMedia(
    mediaId: string,
  ): Promise<{ buffer: Buffer; mimeType: string; filename?: string }> {
    // Step 1: Get the download URL
    const metaRes = await fetch(`${this.graphBase}/${mediaId}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!metaRes.ok) {
      throw new Error(`Failed to get media URL: HTTP ${metaRes.status}`);
    }
    const metaData = (await metaRes.json()) as {
      url: string;
      mime_type: string;
      file_name?: string;
    };

    // Step 2: Download the binary content
    const fileRes = await fetch(metaData.url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!fileRes.ok) {
      throw new Error(`Failed to download media: HTTP ${fileRes.status}`);
    }

    const arrayBuffer = await fileRes.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType: metaData.mime_type,
      filename: metaData.file_name,
    };
  }

  /**
   * Send a media message (image / audio / video / document by MIME) — uploads
   * the bytes, then sends by media id. Returns the sent wamid, or null when
   * Meta refuses (e.g. outside the 24-hour service window).
   */
  async sendMediaMessage(
    to: string,
    media: { buffer: Buffer; filename: string; mimeType: string },
    options: { caption?: string; replyToMessageId?: string } = {},
  ): Promise<string | null> {
    try {
      const mediaId = await this.uploadMedia(media.buffer, media.filename, media.mimeType);
      const kind = media.mimeType.startsWith('image/')
        ? 'image'
        : media.mimeType.startsWith('video/')
          ? 'video'
          : media.mimeType.startsWith('audio/')
            ? 'audio'
            : 'document';
      const payload = {
        messaging_product: 'whatsapp',
        to: this.formatPhoneNumber(to),
        type: kind,
        [kind]: {
          id: mediaId,
          // Audio doesn't take captions; documents carry a filename.
          ...(options.caption !== undefined && kind !== 'audio' ? { caption: options.caption } : {}),
          ...(kind === 'document' ? { filename: media.filename } : {}),
        },
        ...(options.replyToMessageId !== undefined
          ? { context: { message_id: options.replyToMessageId } }
          : {}),
      };
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error('Meta WhatsApp API media-send error:', { error: errorData });
        return null;
      }
      const responseData = await response.json();
      return responseData.messages?.[0]?.id ?? null;
    } catch (error: unknown) {
      logger.error('Failed to send media message via Meta WhatsApp API:', error);
      return null;
    }
  }

  /**
   * Upload media to WhatsApp Business API and get media ID
   */
  private async uploadMedia(buffer: Buffer, filename: string, mimeType: string): Promise<string> {
    try {
      const uploadUrl = `${this.graphBase}/${this.phoneNumberId}/media`;

      // Determine media type category based on MIME type
      let newMediaType = mimeType; // default for documents
      if (mimeType.startsWith('image/')) {
        newMediaType = 'image';
      } else if (mimeType.startsWith('video/')) {
        newMediaType = 'video';
      } else if (mimeType.startsWith('audio/')) {
        newMediaType = 'audio';
      }

      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', newMediaType);
      form.append('file', buffer, {
        filename: filename,
        contentType: mimeType,
      });

      logger.info('Uploading media:', {
        filename,
        mimeType,
        newMediaType,
        uploadUrl,
        bufferSize: buffer.length,
      });

      const response = await axios.post(uploadUrl, form, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          ...form.getHeaders(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: () => true, // Don't throw on any status code
      });

      // Log the full response for debugging
      if (response.status !== 200) {
        logger.error('WhatsApp API upload error response:', {
          status: response.status,
          statusText: response.statusText,
          data: response.data,
          headers: response.headers,
        });

        // Try to extract error message from response
        const errorMessage =
          response.data?.error?.message ||
          response.data?.message ||
          `HTTP ${response.status}: ${response.statusText}`;

        throw new Error(`WhatsApp API Error: ${errorMessage}`);
      }

      const responseData = response.data;

      if (!responseData.id) {
        logger.error('Invalid media upload response:', responseData);
        throw new Error('Failed to get media ID from upload response');
      }

      logger.info('Media uploaded successfully:', {
        mediaId: responseData.id,
        filename,
        mimeType,
        newMediaType,
        bufferSize: buffer.length,
      });

      return responseData.id;
    } catch (error) {
      // Enhanced error logging
      if (axios.isAxiosError(error)) {
        if (error.response) {
          logger.error('WhatsApp API upload error - Response:', {
            status: error.response.status,
            statusText: error.response.statusText,
            data: error.response.data,
            headers: error.response.headers,
          });
        } else if (error.request) {
          logger.error('WhatsApp API upload error - No response:', {
            request: error.request,
          });
        } else {
          logger.error('WhatsApp API upload error - Setup:', {
            message: error.message,
            stack: error.stack,
          });
        }
      } else {
        logger.error('WhatsApp API upload error:', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      throw new Error(`Failed to upload media to WhatsApp`);
    }
  }

  /**
   * Send an image message via WhatsApp Business API
   */
  async sendImageMessage(
    to: string,
    imageBuffer: Buffer,
    caption?: string,
    filename: string = 'image.png',
  ): Promise<string | null> {
    try {
      // Upload the image first
      const mediaId = await this.uploadMedia(imageBuffer, filename, 'image/png');

      // Send the image message
      const payload = {
        messaging_product: 'whatsapp',
        to: this.formatPhoneNumber(to),
        type: 'image',
        image: {
          id: mediaId,
          ...(caption && { caption }),
        },
      };

      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error('Image message send error:', {
          status: response.status,
          statusText: response.statusText,
          error: errorData,
        });
        throw new Error(`Failed to send image: HTTP ${response.status}`);
      }

      const responseData = await response.json();

      if (!responseData.messages || !responseData.messages[0]?.id) {
        logger.error('Invalid image message response:', responseData);
        throw new Error('Failed to send image message - invalid response');
      }

      const messageId = responseData.messages[0].id;
      logger.info('Image message sent successfully:', {
        messageId,
        mediaId,
        to: this.formatPhoneNumber(to),
        hasCaption: !!caption,
      });

      return messageId;
    } catch (error: unknown) {
      logger.error('Failed to send image message:', error);
      throw new Error('Failed to send image message');
    }
  }

  /**
   * Convert CSV buffer to Excel buffer
   */
  private async convertCSVToExcel(csvBuffer: Buffer): Promise<Buffer> {
    try {
      // Parse CSV content
      const csvContent = csvBuffer.toString('utf-8');
      const lines = csvContent.split('\n').filter((line) => line.trim());

      // Create a new workbook
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Sheet1');

      // Parse CSV and add to worksheet
      lines.forEach((line, index) => {
        // Simple CSV parsing - handles basic comma-separated values
        // For more complex CSV (with quotes, escapes), consider using a CSV parser library
        const values = line.split(',').map((cell) => cell.trim());

        // Add row to worksheet
        worksheet.addRow(values);

        // Style the header row
        if (index === 0) {
          const headerRow = worksheet.getRow(1);
          headerRow.font = { bold: true };
          headerRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE0E0E0' },
          };
        }
      });

      // Auto-fit columns
      worksheet.columns.forEach((column) => {
        if (column && column.eachCell) {
          let maxLength = 0;
          column.eachCell({ includeEmpty: true }, (cell) => {
            const columnLength = cell.value ? cell.value.toString().length : 10;
            if (columnLength > maxLength) {
              maxLength = columnLength;
            }
          });
          column.width = maxLength < 10 ? 10 : maxLength + 2;
        }
      });

      // Generate Excel buffer
      const excelBuffer = await workbook.xlsx.writeBuffer();
      return Buffer.from(excelBuffer);
    } catch (error) {
      logger.error('Failed to convert CSV to Excel:', error);
      throw new Error('Failed to convert CSV to Excel format');
    }
  }

  /**
   * Send a CSV file via WhatsApp Business API
   * Converts CSV to Excel format for better preview support across all platforms
   * @param to - The recipient's phone number
   * @param csvBuffer - The CSV file content as a Buffer
   * @param filename - The name of the file (defaults to 'data.xlsx')
   * @param caption - Optional caption for the file
   * @returns The message ID if successful, null otherwise
   */
  async sendCSVFile(
    to: string,
    csvBuffer: Buffer,
    filename: string = 'data.xlsx',
    caption?: string,
  ): Promise<string | null> {
    try {
      // Convert CSV to Excel format
      const excelBuffer = await this.convertCSVToExcel(csvBuffer);

      // Ensure filename has .xlsx extension
      if (!filename.endsWith('.xlsx')) {
        filename = filename.replace(/\.[^/.]+$/, '') + '.xlsx';
      }

      // Upload the Excel file
      const mediaId = await this.uploadMedia(
        excelBuffer,
        filename,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );

      // Send the document message
      const payload = {
        messaging_product: 'whatsapp',
        to: this.formatPhoneNumber(to),
        type: 'document',
        document: {
          id: mediaId,
          filename: filename,
          ...(caption && { caption }),
        },
      };

      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error('CSV file send error:', {
          status: response.status,
          statusText: response.statusText,
          error: errorData,
        });
        throw new Error(`Failed to send CSV file: HTTP ${response.status}`);
      }

      const responseData = await response.json();

      if (!responseData.messages || !responseData.messages[0]?.id) {
        logger.error('Invalid CSV file message response:', responseData);
        throw new Error('Failed to send CSV file - invalid response');
      }

      const messageId = responseData.messages[0].id;
      logger.info('CSV file sent successfully:', {
        messageId,
        mediaId,
        filename,
        to: this.formatPhoneNumber(to),
        hasCaption: !!caption,
        fileSize: csvBuffer.length,
      });

      return messageId;
    } catch (error: unknown) {
      logger.error('Failed to send CSV file:', error);
      throw new Error('Failed to send CSV file');
    }
  }

  /**
   * Send a document file via WhatsApp Business API
   * @param to - The recipient's phone number
   * @param documentBuffer - The document file content as a Buffer
   * @param filename - The name of the document file
   * @param mimeType - The MIME type of the document (e.g., 'application/pdf', 'text/csv', 'application/vnd.ms-excel')
   * @param caption - Optional caption for the document
   * @returns The message ID if successful, null otherwise
   */
  async sendDocument(
    to: string,
    documentBuffer: Buffer,
    filename: string,
    mimeType: string,
    caption?: string,
  ): Promise<string | null> {
    try {
      // Upload the document first
      const mediaId = await this.uploadMedia(documentBuffer, filename, mimeType);

      // Send the document message
      const payload = {
        messaging_product: 'whatsapp',
        to: this.formatPhoneNumber(to),
        type: 'document',
        document: {
          id: mediaId,
          filename: filename,
          ...(caption && { caption }),
        },
      };

      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error('Document send error:', {
          status: response.status,
          statusText: response.statusText,
          error: errorData,
        });
        throw new Error(`Failed to send document: HTTP ${response.status}`);
      }

      const responseData = await response.json();

      if (!responseData.messages || !responseData.messages[0]?.id) {
        logger.error('Invalid document message response:', responseData);
        throw new Error('Failed to send document - invalid response');
      }

      const messageId = responseData.messages[0].id;
      logger.info('Document sent successfully:', {
        messageId,
        mediaId,
        filename,
        mimeType,
        to: this.formatPhoneNumber(to),
        hasCaption: !!caption,
        fileSize: documentBuffer.length,
      });

      return messageId;
    } catch (error: unknown) {
      logger.error('Failed to send document:', error);
      throw new Error('Failed to send document');
    }
  }

  /**
   * Get all message templates from WhatsApp Business API
   */
  async getMessageTemplates(): Promise<WhatsAppApiTemplate[]> {
    try {
      if (!this.businessAccountId) {
        logger.warn('WhatsApp Business Account ID not configured, cannot fetch templates');
        return [];
      }

      const response = await fetch(
        `${this.graphBase}/${this.businessAccountId}/message_templates`,
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
          },
        },
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error('Failed to fetch WhatsApp templates:', {
          status: response.status,
          statusText: response.statusText,
          error: errorData,
        });
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return data.data || [];
    } catch (error: unknown) {
      logger.error('Error fetching WhatsApp templates:', error);
      return [];
    }
  }

  /**
   * Get a specific template by name
   */
  async getTemplateByName(templateName: string): Promise<WhatsAppTemplateDetails | null> {
    try {
      const templates = await this.getMessageTemplates();
      const template = templates.find((t) => t.name === templateName);

      if (!template) {
        logger.warn(`Template ${templateName} not found`);
        return null;
      }

      const bodyComponent = template.components.find((c) => c.type === 'BODY');
      const variables = this.extractVariablesFromTemplate(bodyComponent?.text || '');

      return {
        id: template.id,
        name: template.name,
        body: bodyComponent?.text || '',
        variables,
        language: template.language,
      };
    } catch (error: unknown) {
      logger.error(`Error fetching template ${templateName}:`, error);
      return null;
    }
  }

  /**
   * Extract variable placeholders from template text
   */
  extractVariablesFromTemplate(text: string): string[] {
    const matches = text.match(/\{\{(\d+)\}\}/g) || [];
    return matches.map((_, index) => `param_${index + 1}`);
  }

  /**
   * Format phone number to ensure it's in the correct format for Meta API
   * Removes any non-digit characters except the leading +
   */
  private formatPhoneNumber(phoneNumber: string): string {
    // Remove any existing whatsapp: prefix if present
    let formatted = phoneNumber.replace(/^whatsapp:/, '');

    // Ensure it starts with + and contains only digits after that
    if (!formatted.startsWith('+')) {
      formatted = `+${formatted}`;
    }

    // Remove any non-digit characters except the leading +
    formatted = formatted.replace(/[^\d+]/g, '');

    return formatted;
  }
}

// ── The configured numbers ───────────────────────────────────────────────────
// Primary — the existing WHATSAPP_* number (the default send number).
// Absent-tolerant (empty creds) so the module imports without WhatsApp
// configured; sends then fail at call time, not at import.
//
// This read used `devDefault`, which is ONLY consulted outside production — so
// in production the module threw at import and no deployment could boot without
// a WhatsApp number, whatever products it ran. A deployment's composition root
// decides what is required of it; a subsystem nobody mounted does not get to
// veto the boot (D52(c)).
const metaWhatsappApi = new MetaWhatsAppApiService({
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? '',
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',
  businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? '',
});

/**
 * The movements number's credentials. `WHATSAPP_MOVEMENTS_PHONE_NUMBER_ID` is
 * the ONLY movements-specific value — it's what makes a second number a second
 * number, so it's null (not configured) when absent. The number lives in the
 * SAME Meta app / WABA as the primary number, so it reuses the primary
 * `WHATSAPP_ACCESS_TOKEN` (a WABA-scoped token sends from any number under it)
 * and the primary business account id. It sends from its own number simply by
 * posting to `/{movements-phone-number-id}/messages`.
 */
function movementsNumberCreds(): WhatsappNumberCreds | null {
  const phoneNumberId = process.env.WHATSAPP_MOVEMENTS_PHONE_NUMBER_ID?.trim();
  if (!phoneNumberId) return null;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  if (!accessToken) return null;
  return {
    accessToken,
    phoneNumberId,
    businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID?.trim() || '',
  };
}

/** Registry of send clients keyed by Meta `phone_number_id` — one per configured
 *  number. The receiving number on an inbound message picks the reply's sender. */
const metaWhatsappApiByNumberId = new Map<string, MetaWhatsAppApiService>();
metaWhatsappApiByNumberId.set(metaWhatsappApi.numberId, metaWhatsappApi);
const movementsCreds = movementsNumberCreds();
const metaWhatsappMovementsApi = movementsCreds
  ? new MetaWhatsAppApiService(movementsCreds)
  : null;
if (metaWhatsappMovementsApi) {
  metaWhatsappApiByNumberId.set(metaWhatsappMovementsApi.numberId, metaWhatsappMovementsApi);
}

/** The movements number's Meta `phone_number_id`, captured at load — the single
 *  source of truth for BOTH the send registry above and the inbound gate
 *  (`resolveWhatsappRoute`), so they can't drift. null when no movements number
 *  is configured, which the gate reads as "don't partition yet". */
const movementsPhoneNumberIdValue = movementsCreds?.phoneNumberId ?? null;
function movementsPhoneNumberId(): string | null {
  return movementsPhoneNumberIdValue;
}

/**
 * The send client for a Meta `phone_number_id` — i.e. reply FROM the number an
 * inbound message arrived on. Defaults to the primary number when the id is
 * absent (an old position / the primary door) or unknown (logged — never
 * fabricate a client for an unconfigured number).
 */
function getMetaWhatsappApi(phoneNumberId?: string): MetaWhatsAppApiService {
  if (!phoneNumberId) return metaWhatsappApi;
  const found = metaWhatsappApiByNumberId.get(phoneNumberId);
  if (found) return found;
  logger.warn('[whatsapp] no configured number for phone_number_id — using primary', {
    phoneNumberId,
  });
  return metaWhatsappApi;
}

/** Send a verification code from the movements number, so the user receives it
 *  from — and learns to message — the same Listen-Fire number their movements listen
 *  on. Falls back to the primary number when no movements number is configured. */
async function sendVerificationCode(input: { to: string; code: string }): Promise<void> {
  await getMetaWhatsappApi(movementsPhoneNumberId() ?? undefined).sendVerificationOtp(input);
}

export {
  metaWhatsappApi,
  metaWhatsappMovementsApi,
  getMetaWhatsappApi,
  movementsPhoneNumberId,
  sendVerificationCode,
  MetaWhatsAppApiService,
};
