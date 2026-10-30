'use strict';

const { installSeed, SEEDS } = require('./install');
const { registerSeedPorts } = require('./register');
const { registerUrlGuard } = require('./ports');
const { cadenceDueAt } = require('./cadence.due');
const { CADENCE_SEED_SETTINGS_SCHEMA } = require('./cadence.settings');

registerSeedPorts();

/** Automações prontas do Marketing (M9-D422 a M9-D424): pós-chaves, cadência de locação, lembretes de restrição e pedido de avaliação. */
module.exports = { installSeed, SEEDS, registerUrlGuard, cadenceDueAt, CADENCE_SEED_SETTINGS_SCHEMA };
