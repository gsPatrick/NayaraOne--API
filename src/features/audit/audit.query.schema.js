'use strict';

const V = require('../../shared/validation/requestSchema');

/**
 * Consulta de `GET /audit-log` (rodada 8 da verificação do Marco 9, DI-M9R-24 e DI-M9R-25): `dateFrom=now` ou `dateFrom=infinity` (que o Postgres
 * aceitaria, mas o JavaScript não lê) virava "Invalid date" no comando e o banco recusava um valor que não estava no pedido. As datas têm de ser
 * legíveis; os demais filtros, texto.
 */
const LISTAR = V.objetoAberto({
  userId: V.textoDaConsulta({ max: 36 }),
  entityType: V.textoDaConsulta({ max: 120 }),
  action: V.textoDaConsulta({ max: 120 }),
  entityId: V.textoDaConsulta({ max: 200 }),
  dateFrom: { ...V.dataEmTexto({ nulo: false }), descricao: 'uma data em texto (AAAA-MM-DD ou data e hora ISO)' },
  dateTo: { ...V.dataEmTexto({ nulo: false }), descricao: 'uma data em texto (AAAA-MM-DD ou data e hora ISO)' },
});

module.exports = { validarListagemDaAuditoria: V.validarEntrada({ query: LISTAR }, 'AUDIT_LOG_VALIDATION'), ESQUEMAS: { LISTAR } };
