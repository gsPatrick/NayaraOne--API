'use strict';

const { sendMessage } = require('./send');
const { createTask } = require('./task');
const { notifyUser } = require('./notify');
const { createContentDraft } = require('./draft');
const { requestReview } = require('./review');
const { openCase, updateStageTag } = require('./crm');

/** Um executor por tipo do catálogo (M9-D413): todos application services, nunca SQL direto no destino; todos recebem a action_key. */
const EXECUTORS = Object.freeze({
  SEND_MESSAGE: sendMessage, CREATE_TASK: createTask, NOTIFY_USER: notifyUser, CREATE_CONTENT_DRAFT: createContentDraft, REQUEST_REVIEW: requestReview,
  OPEN_CASE: openCase, UPDATE_CRM_STAGE_TAG: updateStageTag,
});

module.exports = { EXECUTORS };
