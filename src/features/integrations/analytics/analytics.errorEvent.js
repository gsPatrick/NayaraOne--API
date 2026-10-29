'use strict';

const { redactDeep, redactForAi } = require('../../../shared/redaction');

const STACK_MAX = 4000;
const MESSAGE_MAX = 500;

/** Segredo pela redaction da D246 e dado pessoal pelo perfil de texto da NAY: o que sobra é seguro para o serviço de monitoramento. */
const limpar = (texto, max) => redactForAi(String(redactDeep(String(texto || ''))).slice(0, max));

/** Evento de erro de aplicação: nome do erro, mensagem e pilha já redigidos (M9-D243 3.1), mais os ids opacos que o chamador informar. */
function errorToEvent(err, extra = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  return {
    name: 'error.captured',
    properties: { errorName: String(e.name || 'Error').slice(0, 80), message: limpar(e.message, MESSAGE_MAX), stack: limpar(e.stack, STACK_MAX), ...extra },
  };
}

module.exports = { errorToEvent };
