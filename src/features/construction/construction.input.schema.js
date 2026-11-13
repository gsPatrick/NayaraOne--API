'use strict';

const V = require('../../shared/validation/requestSchema');

/**
 * Tipo dos campos de `POST /construction/maintenance-cases`, `/construction/warranty-cases`, `/construction/projects/:id/measurements`, `/construction/stages/:id/measurements` e `/construction/projects`.
 * Rodada 8 da verificação do Marco 9 (12/11/2026; DI-M9R-25): o guarda genérico de tipo (clientTypeErrors.js) foi retirado, porque transformava em
 * 400 qualquer defeito do servidor sempre que o pedido trazia um número, um booleano ou uma lista. Estas rotas, que dependiam dele, passam a conferir
 * na porta o TIPO dos campos que o serviço usa em consulta ao banco (identificador em texto, texto, lista de identificadores). Esquemas ABERTOS
 * (campo que o esquema não cita passa, como sempre passou); a regra de negócio continua no serviço, com o código de erro do módulo.
 */

const CHAMADO = V.objetoAberto({
  propertyId: V.identificador(), projectId: V.identificador(), openedByPersonId: V.identificador(), responsibleUserId: V.identificador(),
  description: V.texto(), category: V.texto(), severity: V.texto(), rootCauseCode: V.texto(), warrantyDeadlineAt: V.dataEmTexto(),
  beforeMediaFileIds: V.lista(V.identificador({ nulo: false, vazio: false })),
});
const OBRA = V.objetoAberto({
  propertyId: V.identificador(), unitId: V.identificador(), responsibleUserId: V.identificador(), costCenterId: V.identificador(), name: V.texto(), code: V.texto(),
  budgetAmount: V.numeroOuTexto(), startsAt: V.dataEmTexto(), endsAtPlanned: V.dataEmTexto(),
});
const MEDICAO = V.objetoAberto({
  projectStageId: V.identificador(), costCenterId: V.identificador(), idempotencyKey: V.texto(), notes: V.texto(), measuredAt: V.dataEmTexto(),
  items: V.lista({ type: ['object', 'null'], descricao: 'um objeto' }),
});

module.exports = {
  validarChamado: V.validarEntrada({ body: CHAMADO }, 'MAINTENANCE_CASE_VALIDATION'),
  validarMedicao: V.validarEntrada({ body: MEDICAO }, 'STAGE_MEASUREMENT_VALIDATION'),
  validarObra: V.validarEntrada({ body: OBRA }, 'PROJECT_VALIDATION'),
  ESQUEMAS: { CHAMADO, MEDICAO, OBRA },
};
