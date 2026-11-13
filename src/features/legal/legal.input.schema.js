'use strict';

const V = require('../../shared/validation/requestSchema');

/**
 * Tipo dos campos de `POST /legal/clauses`, `/legal/contracts/:id/versions`, `/legal/notices`, `/legal/contract-templates/:id/render` e `/legal/contracts`.
 * Rodada 8 da verificação do Marco 9 (12/11/2026; DI-M9R-25): o guarda genérico de tipo (clientTypeErrors.js) foi retirado, porque transformava em
 * 400 qualquer defeito do servidor sempre que o pedido trazia um número, um booleano ou uma lista. Estas rotas, que dependiam dele, passam a conferir
 * na porta o TIPO dos campos que o serviço usa em consulta ao banco (identificador em texto, texto, lista de identificadores). Esquemas ABERTOS
 * (campo que o esquema não cita passa, como sempre passou); a regra de negócio continua no serviço, com o código de erro do módulo.
 */

const CLAUSULA = V.objetoAberto({ code: V.texto(), title: V.texto(), bodyText: V.texto(), category: V.texto(), condition: V.objeto() });
const VERSAO_DO_CONTRATO = V.objetoAberto({
  documentFileId: V.identificador(), templateId: V.identificador(), effectiveFrom: V.dataEmTexto(), variables: V.objeto(),
  clauseVersionIds: V.lista(V.identificador({ nulo: false, vazio: false })),
});
const CONTRATO = V.objetoAberto({
  propertyId: V.identificador(), opportunityId: V.identificador(), constructionProjectId: V.identificador(), contractType: V.texto(), contractNumber: V.texto(),
  totalValue: V.numeroOuTexto(), startsAt: V.dataEmTexto(), endsAt: V.dataEmTexto(),
});
const RENDERIZACAO = V.objetoAberto({ contractId: V.identificador(), variables: V.objeto(), draftContract: V.objeto(), simulationContext: V.objeto() });
const NOTIFICACAO = V.objetoAberto({
  contractId: V.identificador(), legalCaseId: V.identificador(), recipientPersonId: V.identificador(), contentFileId: V.identificador(),
  channel: V.texto(), recipientDescription: V.texto(), content: V.texto(),
});

module.exports = {
  validarClausula: V.validarEntrada({ body: CLAUSULA }, 'LEGAL_CONTRACT_CLAUSE_VALIDATION'),
  validarVersaoDoContrato: V.validarEntrada({ body: VERSAO_DO_CONTRATO }, 'LEGAL_CONTRACT_VERSION_VALIDATION'),
  validarNotificacao: V.validarEntrada({ body: NOTIFICACAO }, 'LEGAL_NOTICE_VALIDATION'),
  validarRenderizacao: V.validarEntrada({ body: RENDERIZACAO }, 'LEGAL_CONTRACT_TEMPLATE_VALIDATION'),
  validarContrato: V.validarEntrada({ body: CONTRATO }, 'LEGAL_CONTRACT_VALIDATION'),
  ESQUEMAS: { CLAUSULA, VERSAO_DO_CONTRATO, NOTIFICACAO, RENDERIZACAO, CONTRATO },
};
