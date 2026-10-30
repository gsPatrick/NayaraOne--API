'use strict';

const { formatar } = require('./format');
const { RAIZ_PADRAO } = require('./source');

// A ordem é a da tabela do livro (Guia §14, M9-D440).
const GUARDAS = [
  require('./cadence'), require('./sendPolicy'), require('./factualGate'), require('./publicPayload'),
  require('./noBlindRetry'), require('./killSwitch'), require('./reviewGate'), require('./replay'),
];

/** Roda as 8 guardas sobre a raiz da API (ou de uma cópia com violação injetada). Devolve [{ guarda, violacoes: [{ guarda, arquivo, linha, regra }] }]. */
function rodarTodas(raiz = RAIZ_PADRAO) {
  return GUARDAS.map((g) => ({ guarda: g.NOME, violacoes: g.verificar(raiz).map((v) => ({ guarda: g.NOME, ...v })) }));
}

module.exports = { GUARDAS, rodarTodas, formatar };
