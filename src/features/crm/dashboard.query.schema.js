'use strict';

const V = require('../../shared/validation/requestSchema');

/**
 * Consulta de `GET /crm/dashboard` (rodada 8 da verificação do Marco 9, DI-M9R-24 e DI-M9R-25): `createdFrom=now` virava "Invalid date" no comando e
 * o banco recusava um valor que não estava no pedido. Identificadores em texto (UUID) e datas ISO 8601 válidas.
 */
const UUID = `^(?:|${V.UUID_PATTERN.slice(1, -1)})$`;
const id = () => V.textoDaConsulta({ max: 36, padrao: UUID, descricao: 'um identificador (UUID) em texto' });
const data = () => ({ ...V.dataEmTexto({ nulo: false }) });
const PAINEL = V.objetoAberto({ ownerUserId: id(), personId: id(), propertyId: id(), createdFrom: data(), createdTo: data() });

module.exports = { validarConsultaDoPainel: V.validarEntrada({ query: PAINEL }, 'CRM_DASHBOARD_VALIDATION'), ESQUEMAS: { PAINEL } };
