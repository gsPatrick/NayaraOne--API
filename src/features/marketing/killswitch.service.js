'use strict';

const router = require('./killswitch.routes');
const state = require('./killswitch.state');
const registry = require('./killswitch.registry');
const hooks = require('./killswitch.hooks');
const { activateFromIncident } = require('./killswitch.incident');
const { changeKillSwitch } = require('./killswitch.change');
const { parseChange } = require('./killswitch.input');
const { listLog } = require('./killswitch.log');
const { registerSocialKillSwitchCheck } = require('./killswitch.social');
const constants = require('./killswitch.constants');
const { KILLSWITCH_SETTINGS_SCHEMA, KILLSWITCH_SETTING_DEFAULTS } = require('./killswitch.settings');
require('./killswitch.probe');
const { provisionKillSwitches } = require('./killswitch.provision');

registerSocialKillSwitchCheck();

/**
 * Kill switch do Marketing (M9-D425): global, por canal, por campanha e por automação. Fachada do kill switch (arquivos killswitch.*.js): o resto do Marketing, o runner de automação (M9-D414), os workers de
 * publicação e o módulo de incidentes importam só daqui. `assertOutboundAllowed`/`isOutboundBlocked` são o ponto único de leitura, com falha fechada.
 */
module.exports = {
  router,
  ...state,
  ...hooks,
  ensureKillSwitches: registry.ensureAll,
  provisionKillSwitches,
  activateFromIncident,
  changeKillSwitch,
  parseChange,
  listKillSwitchLog: listLog,
  KILLSWITCH_CONSTANTS: constants,
  KILLSWITCH_SETTINGS_SCHEMA,
  KILLSWITCH_SETTING_DEFAULTS,
};
