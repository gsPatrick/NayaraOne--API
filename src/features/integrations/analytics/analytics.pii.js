'use strict';

const AppError = require('../../../utils/AppError');
const { redactDeepForAi } = require('../../../shared/redaction');

/**
 * O serviço de métricas e eventos só recebe identificadores opacos e agregados (M9-D243 3.1). A detecção é a da biblioteca única de
 * redaction (D246/D027): CPF, CNPJ, e-mail, telefone, endereço, cartão, conta, chave de API e chave com nome de segredo. Se a redação mudaria
 * alguma parte do conteúdo, ali havia dado pessoal ou segredo e o envio é recusado (422), antes de gravar qualquer coisa.
 */
const blocked = () => AppError.unprocessable('Dado pessoal não pode ser enviado ao serviço de métricas.', 'INTEGRATION_ANALYTICS_PII_BLOCKED');

function assertNoPersonalData(content) {
  const limpo = redactDeepForAi(content);
  if (JSON.stringify(limpo) !== JSON.stringify(content)) throw blocked();
}

module.exports = { assertNoPersonalData };
