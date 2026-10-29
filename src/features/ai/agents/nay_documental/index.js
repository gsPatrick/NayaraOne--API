'use strict';

const { CODE, DEFINITION } = require('./definition');
const { SCOPE_DEFINITION, checkAnswer } = require('./boundary');
const { CASES } = require('./golden');
const { DOCUMENTAL_SETTING_DEFAULTS, DOCUMENTAL_SETTINGS_SCHEMA } = require('./documental.settings');
const { registerAgentScope, wireScopeGuard } = require('../scope');
const { registerAgentHooks } = require('../agentHooks');

/**
 * NAY Documental (M9-D040): OCR, classificação, extração e checagem de documentos da empresa, sempre como sugestão para revisão humana.
 * Registra a fronteira (recusa de pedido fora do propósito e das quatro proibições) e o gancho de resposta. Idempotente. As ferramentas
 * `documents.*` estão em tools/definitions e o serviço delas em ./services.js.
 */
function registerNayDocumental() {
  registerAgentScope(SCOPE_DEFINITION);
  wireScopeGuard();
  registerAgentHooks(CODE, { checkAnswer });
}

module.exports = { CODE, DEFINITION, GOLDEN_CASES: CASES, DOCUMENTAL_SETTING_DEFAULTS, DOCUMENTAL_SETTINGS_SCHEMA, registerNayDocumental };
