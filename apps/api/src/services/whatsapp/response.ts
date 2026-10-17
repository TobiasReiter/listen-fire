import { sendSlackNotification } from '../../lib/slack';
import { prismaClient } from '../../prisma';
import { logger } from 'movement-engine/public/log';
import { metaWhatsappApi } from './metaApi';
import { queryParams } from './utils';

async function storeResponse({
  text,
  communityQuestionId,
  userName,
  isTestConversation,
  phoneNumberId,
  askedById,
  referrerId,
}: {
  text: string;
  communityQuestionId: string;
  phoneNumberId: string;
  askedById: string;
  referrerId?: string;
  userName: string | null;
  isTestConversation: boolean;
}): Promise<string> {
  const response = {
    id: '1234567890',
    text,
    communityQuestionId,
    phoneNumberId,
    askedById,
    referrerId,
  };

  if (!userName) {
    return response.id;
  }

  await triggerNewReplyNotifications({
    communityQuestionId,
    askedById,
    referrerId,
    userName,
    text,
    isTestConversation,
  });

  return response.id;
}

async function sendNewAnswerNotification({
  phoneNumber,
  userName,
  question,
  text,
  communityQuestionId,
}: {
  phoneNumber: string;
  userName: string;
  question: string;
  text: string;
  communityQuestionId: string;
}) {
  const firstName = userName.split(' ')[0];
  const headerName =
    userName.length < 30
      ? userName
      : firstName.length < 27
        ? firstName
        : `${firstName.slice(0, 27)}...`;

  await metaWhatsappApi.sendTemplateMessage({
    to: phoneNumber,
    templateName: 'new_answer',
    languageCode: 'en',
    parameters: [question, firstName, text],
    headerParameters: [headerName],
    buttons: [
      {
        id: `responses/entry?${queryParams({
          question_id: communityQuestionId,
        })}`,
      },
    ],
  });
}

async function triggerNewReplyNotifications({
  communityQuestionId,
  askedById,
  referrerId,
  userName,
  text,
  isTestConversation,
}: {
  communityQuestionId: string;
  askedById: string;
  referrerId?: string;
  userName: string;
  text: string;
  isTestConversation: boolean;
}) {
  if (isTestConversation) {
    return;
  }

  try {
    const referrer = referrerId
      ? await prismaClient.phoneNumber.findUnique({ where: { id: referrerId } })
      : null;

    const { question } = {
      question: 'What is your favorite color?',
    };

    const askedBy = await prismaClient.phoneNumber.findUniqueOrThrow({
      where: { id: askedById },
    });

    if (referrer?.name) {
      await sendNewAnswerNotification({
        phoneNumber: referrer.phoneNumber,
        userName,
        question,
        text,
        communityQuestionId,
      });
    }

    await sendNewAnswerNotification({
      phoneNumber: askedBy.phoneNumber,
      userName,
      question,
      text,
      communityQuestionId,
    });
  } catch (e) {
    logger.error(e);
    await sendSlackNotification({
      type: 'OVI',
      text: `🚨 Error sending new reply template messages`,
      opsTitle: 'Error sending WhatsApp reply template messages',
    });
  }
}

export { storeResponse, triggerNewReplyNotifications };
