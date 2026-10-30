'use strict';

const { installSeed, SEEDS } = require('./install');
const { registerSeedPorts } = require('./register');
const { registerUrlGuard } = require('./ports');
const { cadenceDueAt } = require('./cadence.due');
const { SEEDS_SETTINGS_SCHEMA } = require('./seeds.settings');

registerSeedPorts();
require('./lead.register').registerLeadSeeds(); // M9-D420: lead novo, sem retorno e cliente frio
require('./radar.register').registerRadarSeed(); // M9-D421: novo imóvel compatível pelo Radar
require('./reviewFlow.register').registerReviewSeeds(); // M9-D424: pedido de avaliação (positiva) ou ocorrência antes (negativa)

/** Automações prontas do Marketing (M9-D422 a M9-D424): pós-chaves, cadência de locação, lembretes de restrição e pedido de avaliação. */
module.exports = { installSeed, SEEDS, registerUrlGuard, cadenceDueAt, SEEDS_SETTINGS_SCHEMA };
