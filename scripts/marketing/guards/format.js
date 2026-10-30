'use strict';

const CODIGO = 'MKT_GUARD_VIOLATION';

/** Mensagem em português: o código, o nome da guarda, o arquivo e a linha, e a regra violada. */
function formatar(v) {
  return `${CODIGO} Violação de regra arquitetural do Marketing: [${v.guarda}] ${v.arquivo}:${v.linha} ${v.regra}`;
}

module.exports = { CODIGO, formatar };
