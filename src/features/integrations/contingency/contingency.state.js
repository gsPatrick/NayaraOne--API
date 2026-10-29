'use strict';

const { sequelize, IntegrationError } = require('../../../models');
const { getCurrentCorrelationId } = require('../../../middlewares/correlationId.middleware');
const { ERROR_CODE, FAMILY_MARKER_PREFIX } = require('./contingency.constants');

/**
 * Estado da contingência (M9-D226 3.2): NÃO há tabela nova. A contingência ativa de uma connection (ou de uma família sem connection
 * ativa) é a linha ABERTA de `integration.integration_errors` com o código CONTINGENCY_ACTIVE (origem HEALTH). Encerrar a contingência
 * é resolver essa linha. Ativar enquanto já está ativa é no-op: o par (empresa, escopo) é serializado por trava consultiva.
 * Escopo: `{ connectionId }` ou `{ domain }` (família sem connection ativa; a linha leva o marcador `familia:<DOMÍNIO>` no fornecedor).
 */
const markerOf = (domain) => `${FAMILY_MARKER_PREFIX}${domain}`.slice(0, 48);

const whereOf = (ctx, scope) => ({
  companyId: ctx.companyId, status: 'OPEN', errorCode: ERROR_CODE,
  ...(scope.connectionId ? { connectionId: scope.connectionId } : { connectionId: null, providerCode: markerOf(scope.domain) }),
});

async function lockScope(ctx, scope, transaction) {
  const chave = `contingency|${ctx.companyId}|${scope.connectionId || markerOf(scope.domain)}`;
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:chave))', { replacements: { chave }, transaction });
}

const findActive = (ctx, scope, transaction) => IntegrationError.findOne({ where: whereOf(ctx, scope), transaction });

const listActiveRows = (ctx, transaction) => IntegrationError.findAll({ where: { companyId: ctx.companyId, status: 'OPEN', errorCode: ERROR_CODE }, order: [['created_at', 'ASC']], transaction });

/** Abre a linha da contingência. `details`: { mode, reasons[], domain, providerCode }. Devolve { row, created }. */
async function openActive(ctx, scope, details, message, transaction) {
  await lockScope(ctx, scope, transaction);
  const existente = await findActive(ctx, scope, transaction);
  if (existente) return { row: existente, created: false };
  // Gravação direta (e não recordError): o agrupamento por janela do recordError juntaria famílias diferentes na mesma linha. O conteúdo é todo nosso (sem dado do fornecedor).
  const row = await IntegrationError.create({
    groupId: ctx.groupId, companyId: ctx.companyId, connectionId: scope.connectionId || null,
    providerCode: scope.connectionId ? details.providerCode : markerOf(scope.domain), source: 'HEALTH', errorClass: 'TRANSIENT', errorCode: ERROR_CODE, severity: 'HIGH', message,
    sanitizedPayload: { mode: details.mode, domain: details.domain, reasons: (details.reasons || []).join(','), providerCode: details.providerCode || null }, attempts: 1,
    correlationId: String(getCurrentCorrelationId() || '').slice(0, 64) || null,
  }, { transaction });
  return { row, created: true };
}

/** Visão da linha para a API e para os eventos. */
function toView(row) {
  const p = row.sanitizedPayload || {};
  return {
    id: row.id, connectionId: row.connectionId, providerCode: p.providerCode || (row.connectionId ? row.providerCode : null), domain: p.domain || null,
    mode: p.mode || null, reasons: typeof p.reasons === 'string' && p.reasons ? p.reasons.split(',') : [], since: row.createdAt, scope: row.connectionId ? 'CONNECTION' : 'FAMILY',
  };
}

module.exports = { markerOf, findActive, listActiveRows, openActive, lockScope, toView };
