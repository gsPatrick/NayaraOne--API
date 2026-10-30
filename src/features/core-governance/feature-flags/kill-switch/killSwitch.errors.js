'use strict';

const { govError } = require('../../governance.errors');

/** Erros do kill switch (M9-D872 §4): códigos GOV_KILL_*, mensagens em português. */
const probeRequired = (details) => govError(422, 'GOV_KILL_PROBE_REQUIRED', 'Todo kill switch precisa de um teste automatizado.', details);
const drillProdForbidden = () => govError(403, 'GOV_KILL_DRILL_PROD_FORBIDDEN', 'O teste automático não roda em produção.');

module.exports = { probeRequired, drillProdForbidden };
