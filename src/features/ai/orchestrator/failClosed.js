'use strict';

/**
 * Falha fechada da NAY (M9-D013): o que continua disponível quando o modelo cai sem substituto seguro. Para agente CRITICAL, o resultado
 * de regra/código já apurado no run (números do read model) segue disponível, sem texto gerado; os demais não devolvem nada além do erro.
 * Nenhuma ação é executada e nenhuma tool roda depois da falha.
 */
function describeAvailable(state) {
  const payload = Array.isArray(state.numbersPayload) ? state.numbersPayload : [];
  if (!state.agent || state.agent.criticality !== 'CRITICAL' || !payload.length) return null;
  return { ruleResult: payload, generatedText: null };
}

module.exports = { describeAvailable };
