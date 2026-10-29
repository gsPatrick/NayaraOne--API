'use strict';

const { sequelize, IntegrationDispatch, IntegrationConnection } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { getCurrentCorrelationId } = require('../../../middlewares/correlationId.middleware');
const { hashPayload } = require('./canonicalJson');
const { readDispatchParams } = require('./dispatch.params');
const { keyRequired } = require('./dispatch.errors');
const { auditarMudanca } = require('./dispatch.audit');
const { CRITICALITY_OPS } = require('./dispatch.constants');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INSERT_SQL = `
INSERT INTO "integration"."dispatches"
  (group_id, company_id, connection_id, provider_code, operation, outbox_event_id, aggregate_type, aggregate_id, criticality_op,
   payload_snapshot, payload_hash, idempotency_key, max_attempts, next_attempt_at, correlation_id, created_by, purpose, fields_dropped, confirmation_mode, essential)
VALUES (:groupId, :companyId, :connectionId, :providerCode, :operation, :outboxEventId, :aggregateType, :aggregateId, :criticalityOp,
        CAST(:snapshot AS jsonb), :hash, :key, :maxAttempts, COALESCE(CAST(:nextAttemptAt AS timestamptz), now()), :correlationId, :createdBy, :purpose, :fieldsDropped, :confirmationMode, :essential)
ON CONFLICT (connection_id, operation, idempotency_key) DO NOTHING
RETURNING id`;

/**
 * createDispatch — registra a intenção local de uma chamada externa ANTES de ela sair (estado PENDING), com o conteúdo
 * aprovado (`snapshot`, já minimizado), o hash do JSON canônico e a chave de idempotência. Repetir o pedido com a mesma
 * (conexão, operação, chave) não grava de novo e devolve o envio existente (`created:false`).
 * `d`: connectionId, operation, idempotencyKey, snapshot, criticalityOp (padrão DANGEROUS), outboxEventId, aggregateType, aggregateId,
 * purpose e fieldsDropped (M9-D219: quem minimiza informa; envio com mapper sai por createMinimizedDispatch), maxAttempts (M9-D216: da política
 * efetiva da conexão; sem ele vale o parâmetro da empresa), confirmationMode (M9-D214: copiado do port) e nextAttemptAt (envio agendado:
 * o worker só o pega a partir desta data; sem ele sai já, M9-D239).
 */
async function createDispatch(ctx, d, transaction) {
  if (!ctx || !ctx.companyId || !ctx.groupId) throw AppError.badRequest('Envio exige a empresa e o grupo.', 'VALIDATION_ERROR');
  const key = typeof d.idempotencyKey === 'string' ? d.idempotencyKey.trim() : '';
  if (!key) throw keyRequired();
  if (key.length > 120) throw AppError.unprocessable('A chave de idempotência aceita até 120 caracteres.', 'INTEGRATION_IDEMPOTENCY_KEY_INVALID');
  const operation = typeof d.operation === 'string' ? d.operation.trim() : '';
  if (!operation || operation.length > 64) throw AppError.unprocessable('Informe a operação do envio (até 64 caracteres).', 'INTEGRATION_DISPATCH_INVALID');
  if (!d.snapshot || typeof d.snapshot !== 'object' || Array.isArray(d.snapshot)) throw AppError.unprocessable('Informe o conteúdo aprovado do envio.', 'INTEGRATION_DISPATCH_INVALID');
  const criticalityOp = d.criticalityOp || 'DANGEROUS';
  if (!CRITICALITY_OPS.includes(criticalityOp)) throw AppError.unprocessable(`Criticidade da operação inválida. Use: ${CRITICALITY_OPS.join(', ')}.`, 'INTEGRATION_DISPATCH_INVALID');

  // A FK da conexão ignora a RLS: a leitura aqui, sob a empresa da sessão, garante que a conexão é desta empresa.
  const connection = await IntegrationConnection.findOne({ where: { id: d.connectionId, companyId: ctx.companyId }, attributes: ['id', 'providerCode'], transaction });
  if (!connection) throw AppError.notFound('Integração não encontrada.', 'INTEGRATION_CONNECTION_NOT_FOUND');

  const params = await readDispatchParams(ctx, transaction);
  const correlation = d.correlationId || getCurrentCorrelationId();
  const hash = hashPayload(d.snapshot);
  const [rows] = await sequelize.query(INSERT_SQL, {
    replacements: {
      groupId: ctx.groupId, companyId: ctx.companyId, connectionId: connection.id, providerCode: connection.providerCode, operation,
      outboxEventId: d.outboxEventId || null, aggregateType: d.aggregateType ? String(d.aggregateType).slice(0, 128) : null, aggregateId: d.aggregateId || null,
      criticalityOp, snapshot: JSON.stringify(d.snapshot), hash, key, maxAttempts: Number.isInteger(d.maxAttempts) && d.maxAttempts >= 1 ? d.maxAttempts : params.maxAttempts,
      correlationId: correlation && UUID_RE.test(correlation) ? correlation : null, createdBy: ctx.userId || null,
      purpose: d.purpose || null, fieldsDropped: Number.isInteger(d.fieldsDropped) ? d.fieldsDropped : null,
      essential: d.essential === true,
      nextAttemptAt: d.nextAttemptAt instanceof Date && !Number.isNaN(d.nextAttemptAt.getTime()) ? d.nextAttemptAt.toISOString() : null,
      confirmationMode: ['ON_RESPONSE', 'ON_STATUS'].includes(d.confirmationMode) ? d.confirmationMode : null,
    },
    transaction,
  });
  if (rows.length === 0) {
    const existente = await IntegrationDispatch.findOne({ where: { connectionId: connection.id, operation, idempotencyKey: key }, transaction });
    return { dispatch: existente, created: false };
  }
  const dispatch = await IntegrationDispatch.findByPk(rows[0].id, { transaction });
  await auditarMudanca(ctx, null, dispatch, 'Envio registrado antes da chamada externa.', transaction);
  return { dispatch, created: true };
}

module.exports = { createDispatch };
