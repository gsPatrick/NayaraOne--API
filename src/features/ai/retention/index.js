'use strict';

const { purgeExpiredAiContent } = require('./retention.service');
const { readRetentionParams } = require('./retention.params');
const { providerRetentionCaps } = require('./retention.providerCaps');
const settings = require('./retention.settings');

/** Retenção do conteúdo da NAY (M9-D028). */
module.exports = { purgeExpiredAiContent, readRetentionParams, providerRetentionCaps, ...settings };
