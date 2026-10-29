'use strict';

const AppError = require('../../../utils/AppError');

/** 503 para quem chama sem fila e esbarra no circuito aberto (M9-D217 seção 4). `until` = quando a próxima chamada pode ser tentada. */
function circuitOpen({ reason = 'CIRCUIT_OPEN', until = null, circuitKey = null } = {}) {
  const e = AppError.internal('Fornecedor temporariamente indisponível; a operação foi reagendada.', 'INTEGRATION_CIRCUIT_OPEN', { reason, until });
  e.statusCode = 503;
  if (circuitKey) e.circuitKey = circuitKey;
  return e;
}

const MENSAGEM_ABERTURA = 'O fornecedor ficou indisponível: o circuito foi aberto, as chamadas não essenciais esperam o fim do cooldown e a contingência da família foi acionada.';

module.exports = { circuitOpen, MENSAGEM_ABERTURA };
