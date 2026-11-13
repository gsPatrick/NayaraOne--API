'use strict';

const V = require('../../shared/validation/requestSchema');

/**
 * Tipo dos campos de `POST /procurement/supplier-qualifications` e `POST /procurement/insurance-policies`.
 * Rodada 8 da verificação do Marco 9 (12/11/2026; DI-M9R-25): o guarda genérico de tipo (clientTypeErrors.js) foi retirado, porque transformava em
 * 400 qualquer defeito do servidor sempre que o pedido trazia um número, um booleano ou uma lista. Estas rotas, que dependiam dele, passam a conferir
 * na porta o TIPO dos campos que o serviço usa em consulta ao banco (identificador em texto, texto, lista de identificadores). Esquemas ABERTOS
 * (campo que o esquema não cita passa, como sempre passou); a regra de negócio continua no serviço, com o código de erro do módulo.
 */

const QUALIFICACAO = V.objetoAberto({
  supplierPersonId: V.identificador(),
  documentFileIds: V.lista(V.identificador({ nulo: false, vazio: false })),
  validUntil: V.dataEmTexto(),
  highRisk: V.booleano(),
});

const APOLICE = V.objetoAberto({
  propertyId: V.identificador(), contractId: V.identificador(), coverageSummary: V.texto(),
  parties: V.lista(V.objetoAberto({ partyRole: V.texto(), personId: V.identificador() })),
});

module.exports = {
  validarQualificacao: V.validarEntrada({ body: QUALIFICACAO }, 'SUPPLIER_QUALIFICATION_VALIDATION'),
  validarApolice: V.validarEntrada({ body: APOLICE }, 'INSURANCE_POLICY_VALIDATION'),
  ESQUEMAS: { QUALIFICACAO, APOLICE },
};
