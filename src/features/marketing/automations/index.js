'use strict';

const router = require('./automations.routes');
const service = require('./automations.service');
const cadence = require('./cadence'); // M9-D417: interface usada por outras áreas (ex.: fuso da empresa em campanhas, M9-D412)
const policy = { ...require('./policy'), ...require('./policy.reserve'), ...require('./facts'), ...require('./frequency'), ...require('./policy.reasons'), ...require('./policy.statuses') }; // M9-D416

const runner = require('./runner'); // M9-D414: automation runner (9 passos, ações adiadas, agenda); as portas para outras áreas são registradas em marketing/index.js

module.exports = { router, service, cadence, policy, runner };
