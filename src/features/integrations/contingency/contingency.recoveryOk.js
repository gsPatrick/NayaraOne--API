'use strict';

/** Regra pura da recuperação (M9-D226 3.3 item 4): circuito CLOSED, saúde fora de DOWN e `checks` testes de saúde seguidos OK. `saude` = getCurrentHealth. */
function effectiveOk(saude, checks) {
  if (!saude) return false;
  if (saude.circuitState !== 'CLOSED') return false;
  if (saude.healthStatus === 'DOWN') return false;
  return Number(saude.checkConsecutiveOk || 0) >= checks;
}

module.exports = { effectiveOk };
