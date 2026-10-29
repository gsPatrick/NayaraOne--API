'use strict';

const { definePort } = require('../ports/definePort');

/** Port MessagingAdapter (domínio MESSAGING, M9-D209): operações, entradas e saída normalizada versionadas. */
const MessagingAdapter = definePort('MessagingAdapter', 'MESSAGING', {
  sendText: ['to', 'text'],
  sendTemplate: ['to', 'templateName'],
  sendMedia: ['to', 'mediaRef'],
  getStatus: ['externalResourceId'],
});

module.exports = { MessagingAdapter };
