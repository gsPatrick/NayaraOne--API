'use strict';

const { definePort } = require('../ports/definePort');
const { messaging } = require('../../minimization/mappers');

/** Port MessagingAdapter (domínio MESSAGING, M9-D209): operações, entradas e saída normalizada versionadas. */
const MessagingAdapter = definePort('MessagingAdapter', 'MESSAGING', {
  sendText: { required: ['to', 'text'], outputMapper: messaging.sendText },
  sendTemplate: { required: ['to', 'templateName'], outputMapper: messaging.sendTemplate },
  sendMedia: { required: ['to', 'mediaRef'], outputMapper: messaging.sendMedia },
  getStatus: ['externalResourceId'],
});

module.exports = { MessagingAdapter };
