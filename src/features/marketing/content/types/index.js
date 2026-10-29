'use strict';

const { DEFINITIONS, PRIVATE_CHANNELS, PUBLIC_CHANNELS, ALL_CHANNELS } = require('./definitions');
const { getDefinition, assertCreatable, assertChannelsAllowed } = require('./validate');
const { reductionPercent } = require('./priceReduction');
const { createTriggeredDraft } = require('./triggers.create');
const { runBirthdayDrafts, runConstructionDrafts } = require('./scheduled');
const consumers = require('./triggers.consumers');
const { TYPES_SETTINGS_SCHEMA, TYPES_SETTING_DEFAULTS, readConstructionScanMinutes } = require('./settings');

/** Os 10 tipos de conteúdo do Marketing (M9-D409): definições, validação, gatilhos e rotinas diárias. */
module.exports = {
  DEFINITIONS, PRIVATE_CHANNELS, PUBLIC_CHANNELS, ALL_CHANNELS, getDefinition, assertCreatable, assertChannelsAllowed, reductionPercent,
  createTriggeredDraft, runBirthdayDrafts, runConstructionDrafts, consumers, TYPES_SETTINGS_SCHEMA, TYPES_SETTING_DEFAULTS, readConstructionScanMinutes,
};
