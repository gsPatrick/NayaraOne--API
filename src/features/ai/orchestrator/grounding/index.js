'use strict';

const { validateGrounding } = require('../groundingValidator');
const { loadGroundingSettings, normalizeSettings } = require('./groundingSettings');
const { finalizeGrounding } = require('./finalizeGrounding');
const { GROUNDING_SETTING_DEFAULTS, GROUNDING_SETTINGS_SCHEMA } = require('./grounding.settings');
const constants = require('./grounding.constants');

/** Grounding da resposta da NAY (M9-D025): fontes, snapshot, insuficiência, confiança como sinal e confirmação humana. */
module.exports = {
  validateGrounding, finalizeGrounding, loadGroundingSettings, normalizeSettings, GROUNDING_SETTING_DEFAULTS, GROUNDING_SETTINGS_SCHEMA, constants,
};
