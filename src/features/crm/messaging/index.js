'use strict';

/** Mensageria do CRM sobre o framework de integrações (Marco 9, M9-D229). Fachada da API do módulo. */
const { sendMessage } = require('./messaging.send');
const { refreshStatus } = require('./messaging.refresh');
const { applyMessagingEvent, installMessagingEvents } = require('./messaging.events');
const { installMessageBinder } = require('./messaging.bind');
const { installMessageFailureConsumer } = require('./messaging.failure');
const { MESSAGING_SETTINGS_SCHEMA } = require('./messaging.settings');
const { assertE164 } = require('./messaging.phone');

installMessagingEvents();
installMessageBinder();
installMessageFailureConsumer();

module.exports = { sendMessage, refreshStatus, applyMessagingEvent, assertE164, MESSAGING_SETTINGS_SCHEMA };
