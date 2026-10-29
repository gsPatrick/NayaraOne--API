'use strict';

/**
 * Webhooks de entrada (M9-D210 3.1, M9-D211). A caixa de entrada persistente e o worker moram em ../inbox (M9-D203); aqui ficam o roteador público
 * (POST /v1/webhooks/:provider/:channel), os verificadores de assinatura, o limite WEBHOOK e os aliases das rotas antigas dos fornecedores.
 */
const inbox = require('../inbox');
const router = require('./webhooks.router');
const verifiers = require('./verifiers');
const { legacyAlias } = require('./webhooks.legacy');
const { generateChannelToken } = require('./webhooks.channel');
const { isFrameworkWebhookPath } = require('./webhooks.paths');
const { WEBHOOK_SETTINGS_SCHEMA } = require('./webhooks.settings');

module.exports = { inbox, router, verifiers, verifierFor: verifiers.verifierFor, legacyAlias, generateChannelToken, isFrameworkWebhookPath, WEBHOOK_SETTINGS_SCHEMA };
