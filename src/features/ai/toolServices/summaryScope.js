'use strict';

/**
 * Escopo de dados do agente chamador (`ai.agents.data_scopes`, M9-D035). Uma tool compartilhada entre agentes devolve a lista nominal só quando
 * o agente tem, para a área, um escopo que NÃO termina em `.summary` (ex.: `legal.contracts`); sem escopo da área ou só com `<área>.summary` ela
 * devolve apenas agregados. Falha fechada: quem não declara nada recebe o agregado.
 */
function wantsDetail(scope, area) {
  const scopes = (scope && Array.isArray(scope.dataScopes)) ? scope.dataScopes : [];
  return scopes.some((s) => String(s).startsWith(`${area}.`) && !String(s).endsWith('.summary'));
}

module.exports = { wantsDetail };
