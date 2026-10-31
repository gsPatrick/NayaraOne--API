'use strict';

const { govError, govNotFound } = require('../../core-governance/governance.errors');

/** Erros da carga delta (M9-D900 §4). Códigos novos levam GOV_. */
module.exports = {
  positionGap: (details) => govError(409, 'GOV_MIG_POSITION_GAP', 'O lote começa depois do último checkpoint: há eventos faltando.', details),
  sourceModeInvalid: () => govError(422, 'GOV_MIG_SOURCE_MODE_INVALID', 'Informe CDC ou watermark para esta fonte.'),
  batchRunning: () => govError(409, 'GOV_MIG_BATCH_RUNNING', 'Já existe um lote em execução para esta fonte.'),
  invalidTransition: (from, to) => govError(409, 'GOV_MIG_BATCH_INVALID_TRANSITION', 'Transição de estado inválida para o lote.', { from, to }),
  runInvalid: (message) => govError(422, 'GOV_MIG_RUN_INVALID', message || 'Execução inválida.'),
  eventsOutOfOrder: () => govError(409, 'GOV_MIG_POSITION_GAP', 'O lote começa depois do último checkpoint: há eventos faltando.', { reason: 'EVENTS_OUT_OF_ORDER' }),
  connectorMissing: (name) => govError(422, 'GOV_MIG_CONNECTOR_MISSING', 'A fonte não tem um conector configurado.', { connector: name || null }),
  secretMissing: () => govError(422, 'GOV_MIG_SECRET_MISSING', 'A credencial da fonte não está disponível no ambiente.'),
  targetMissing: (entity) => govError(422, 'GOV_MIG_TARGET_MISSING', 'Não há destino configurado para esta entidade.', { entity }),
  runAlreadyActive: () => govError(409, 'GOV_MIG_RUN_ALREADY_ACTIVE', 'Já existe uma execução desta fonte em andamento.'),
  runLimit: () => govError(429, 'GOV_MIG_RUN_LIMIT', 'Há execuções demais em andamento nesta empresa; aguarde alguma terminar.'),
  legacyScopeInvalid: () => govError(422, 'GOV_MIG_LEGACY_SCOPE_INVALID', 'Informe o código desta empresa no sistema antigo em Configurações > Governança.'),
  legacyScopeRequired: () => govError(422, 'GOV_MIG_LEGACY_SCOPE_REQUIRED', 'O grupo tem mais de uma empresa: ligue o filtro por empresa do sistema antigo antes de migrar.'),
  legacyCodeDuplicate: () => govError(409, 'GOV_MIG_LEGACY_CODE_DUPLICATE', 'Outra empresa do grupo já usa este código no sistema antigo.'),
  batchNotFound: () => govNotFound('Lote não encontrado.'),
  runNotFound: () => govNotFound('Execução não encontrada.'),
};
