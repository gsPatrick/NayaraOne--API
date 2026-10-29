'use strict';

/** Definições de código dos agentes da NAY com conteúdo próprio, para o seed do padrão do sistema. Agente novo acrescenta a sua. */
const SYSTEM_AGENT_DEFINITIONS = Object.freeze([
  require('../nay_correspondente').DEFINITION,
  require('../nay_documental').DEFINITION,
  require('../nay_diretoria').DEFINITION,
  require('../nay_financeira').DEFINITION,
  require('../nay_atendimento').DEFINITION,
]);

module.exports = { SYSTEM_AGENT_DEFINITIONS };
