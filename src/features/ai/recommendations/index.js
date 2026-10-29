'use strict';

const service = require('./recommendation.service');
const settings = require('./recommendation.settings');
const constants = require('./recommendation.constants');

/** ai.recommendations (M9-D007). */
module.exports = { ...service, ...settings, constants };
