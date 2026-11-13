'use strict';

const V = require('../../../shared/validation/requestSchema');

/**
 * Tipo dos campos de `POST /financing-cases` e `POST /financing-cases/:id/documents`.
 * Rodada 8 da verificação do Marco 9 (12/11/2026; DI-M9R-25): o guarda genérico de tipo (clientTypeErrors.js) foi retirado, porque transformava em
 * 400 qualquer defeito do servidor sempre que o pedido trazia um número, um booleano ou uma lista. Estas rotas, que dependiam dele, passam a conferir
 * na porta o TIPO dos campos que o serviço usa em consulta ao banco (identificador em texto, texto, lista de identificadores). Esquemas ABERTOS
 * (campo que o esquema não cita passa, como sempre passou); a regra de negócio continua no serviço, com o código de erro do módulo.
 */

const CASO = V.objetoAberto({
  propertyId: V.identificador(), opportunityId: V.identificador(), providerCode: V.texto(), purpose: V.texto(), product: V.texto(),
  applicants: V.lista(V.objetoAberto({ personId: V.identificador(), role: V.texto() })),
});
const DOCUMENTO = V.objetoAberto({ requirementId: V.identificador(), fileId: V.identificador(), expiresAt: V.dataEmTexto() });

module.exports = {
  validarCaso: V.validarEntrada({ body: CASO }, 'FINANCING_CASE_VALIDATION'),
  validarDocumento: V.validarEntrada({ body: DOCUMENTO }, 'CASE_DOCUMENT_VALIDATION'),
  ESQUEMAS: { CASO, DOCUMENTO },
};
