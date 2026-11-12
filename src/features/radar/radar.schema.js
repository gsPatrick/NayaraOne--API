'use strict';

const { PropertyRadar } = require('../../models');
const V = require('../../shared/validation/requestSchema');

/**
 * Tipo dos campos de identificador e de texto de `POST /radar`, conferidos na porta (verificação independente do Marco 9, rodada 7, 12/11/2026;
 * DI-M9R-21). Antes, `personId` com um objeto, uma lista ou um número dava 500 (`Argument passed to findByPk is invalid`, `uuid = integer`).
 * `criteriaJson` é um objeto (os critérios); a profundidade dele é limitada na porta da API (DI-M9R-18). Esquema ABERTO.
 */
const CRIAR = V.objetoAberto({
  personId: V.identificador(),
  opportunityId: V.identificador(),
  criteriaJson: { type: ['object', 'null'], descricao: 'um objeto JSON com os critérios do radar' },
  status: V.textoDoModelo(PropertyRadar, 'status'),
});

module.exports = { validarCriacaoDeRadar: V.validarEntrada({ body: CRIAR }, 'RADAR_VALIDATION'), ESQUEMAS: { CRIAR } };
