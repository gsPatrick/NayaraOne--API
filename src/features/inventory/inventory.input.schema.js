'use strict';

const V = require('../../shared/validation/requestSchema');

/**
 * Tipo dos campos de `POST /inventory/movements` e `POST /assets/:id/loan`.
 * Rodada 8 da verificação do Marco 9 (12/11/2026; DI-M9R-25): o guarda genérico de tipo (clientTypeErrors.js) foi retirado, porque transformava em
 * 400 qualquer defeito do servidor sempre que o pedido trazia um número, um booleano ou uma lista. Estas rotas, que dependiam dele, passam a conferir
 * na porta o TIPO dos campos que o serviço usa em consulta ao banco (identificador em texto, texto, lista de identificadores). Esquemas ABERTOS
 * (campo que o esquema não cita passa, como sempre passou); a regra de negócio continua no serviço, com o código de erro do módulo.
 */

const MOVIMENTO = V.objetoAberto({
  inventoryItemId: V.identificador(), projectId: V.identificador(), stageId: V.identificador(), sourceLocationId: V.identificador(),
  destinationLocationId: V.identificador(), sourceId: V.identificador(), responsiblePersonId: V.identificador(), evidenceFileId: V.identificador(),
  movementType: V.texto(), sourceType: V.texto(), idempotencyKey: V.texto(), reason: V.texto(), movedAt: V.dataEmTexto(),
});
const EMPRESTIMO = V.objetoAberto({
  personUserId: V.identificador(), destinationLocationId: V.identificador(), dueAt: V.dataEmTexto(), conditionOutCode: V.texto(),
});

module.exports = {
  validarMovimento: V.validarEntrada({ body: MOVIMENTO }, 'INVENTORY_MOVEMENT_VALIDATION'),
  validarEmprestimo: V.validarEntrada({ body: EMPRESTIMO }, 'TOOL_LOAN_VALIDATION'),
  ESQUEMAS: { MOVIMENTO, EMPRESTIMO },
};
