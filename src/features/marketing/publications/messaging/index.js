'use strict';

const { sendMarketingMessage } = require('./message/message.send');
const { applyDeliveryStatus, STATUS_MAP } = require('./delivery/delivery.status');
const { installDeliveryHook } = require('./delivery/delivery.hook');
const { registerDeliveryListener } = require('./delivery/delivery.listeners');
const { previewSafe, previewSensitive, REDACTED } = require('./preview/preview.safe');
const { readPreviewConfig, PREVIEW_SETTINGS_SCHEMA, PREVIEW_SETTING_DEFAULTS } = require('./preview/preview.settings');
const { sendStep, buildMessagingCampaignPort, installCampaignSendPort } = require('./campaign/campaign.port');
const { reconcileMessage, settleMessage } = require('./message/message.followup');
const { signUnsubscribeToken, verifyUnsubscribeToken } = require('./unsubscribe/unsubscribe.token');
const { unsubscribeByToken } = require('./unsubscribe/unsubscribe.service');
const { publicRouter } = require('./unsubscribe/unsubscribe.routes');

installDeliveryHook(); // status de entrega do webhook dos canais -> mensagem do CRM

/** Mensagem direta do Marketing (WhatsApp e e-mail) sobre o ChannelAdapter da M9-D430 (M9-D429). */
module.exports = {
  sendMarketingMessage, applyDeliveryStatus, registerDeliveryListener, STATUS_MAP, previewSafe, previewSensitive, REDACTED, readPreviewConfig, PREVIEW_SETTINGS_SCHEMA, PREVIEW_SETTING_DEFAULTS,
  reconcileMessage, settleMessage, sendStep, buildMessagingCampaignPort, installCampaignSendPort, signUnsubscribeToken, verifyUnsubscribeToken, unsubscribeByToken, publicRouter,
};
