'use strict';

const router = require('./automations.routes');
const service = require('./automations.service');
const cadence = require('./cadence'); // M9-D417: interface usada por outras áreas (ex.: fuso da empresa em campanhas, M9-D412)
const policy = { ...require('./policy'), ...require('./policy.reserve'), ...require('./facts'), ...require('./frequency'), ...require('./policy.reasons'), ...require('./policy.statuses') }; // M9-D416

module.exports = { router, service, cadence, policy };
