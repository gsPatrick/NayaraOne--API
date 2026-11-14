'use strict';

/**
 * Tabelas em que o role de runtime NÃO pode apagar linhas (a retenção é feita por função SECURITY DEFINER,
 * M9-D244). O GRANT em massa por schema (aplicarPermissoesRuntime.js e o cluster descartável) concede DELETE em
 * tudo; estas tabelas voltam a ficar sem ele. Cada demanda de tabela de integração acrescenta a sua aqui.
 */
const RUNTIME_NO_DELETE = Object.freeze([
  '"integration"."provider_health"',
  '"integration"."webhook_inbox"',
  '"integration"."dispatches"',
  '"integration"."integration_errors"',
  // Marco 3 §13: matches gravados do Radar são histórico (migration 20260101009972).
  '"crm"."radar_matches"',
  // Marco 3, M3-08: histórico de preço é append-only (migration 20260101010311, que também tem gatilho).
  '"real_estate"."property_price_history"',
]);

const revokeDeleteSql = (role) => RUNTIME_NO_DELETE.map((tabela) => `REVOKE DELETE ON ${tabela} FROM ${role}`);

module.exports = { RUNTIME_NO_DELETE, revokeDeleteSql };
