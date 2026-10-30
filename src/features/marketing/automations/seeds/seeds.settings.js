'use strict';

const { CADENCE_SEED_SETTINGS_SCHEMA } = require('./cadence.settings');
const { RESTRICAO_SETTINGS_SCHEMA } = require('./restricao.settings');

/** Dicionário de parâmetros de todas as automações prontas do Marketing (M9-D422 a M9-D424): um só ponto para o SETTINGS_SCHEMA. */
const SEEDS_SETTINGS_SCHEMA = { ...CADENCE_SEED_SETTINGS_SCHEMA, ...RESTRICAO_SETTINGS_SCHEMA };

module.exports = { SEEDS_SETTINGS_SCHEMA };
