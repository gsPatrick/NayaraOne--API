'use strict';

const { sequelize, IntegrationConnection, IntegrationSyncCursor } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { CURSOR_KINDS, ORIGINS, STREAM_RE } = require('./sync.constants');
const { auditarCursor, visao } = require('./sync.audit');
const { tenantTx } = require('./sync.tx');

async function agoraDoBanco(transaction) {
  const [[{ agora }]] = await sequelize.query('SELECT now() AS agora', { transaction });
  return new Date(agora);
}

async function carregarConexaoAtiva(connectionId, transaction) {
  const conexao = await IntegrationConnection.findByPk(connectionId, { transaction });
  if (!conexao) throw AppError.notFound('Conexão de integração não encontrada.', 'INTEGRATION_CONNECTION_NOT_FOUND');
  if (conexao.status !== 'ACTIVE') {
    throw AppError.conflict('A conexão não está ativa: não há o que sincronizar.', 'INTEGRATION_CONNECTION_NOT_ACTIVE');
  }
  return conexao;
}

/**
 * Passo (a) do ciclo: adquire o lease do fluxo (conexão + stream) numa transação própria, que comita.
 * A linha é travada (FOR UPDATE), então dois workers nunca passam juntos. Lease vigente de outro worker: 409.
 * Lease vencido (worker morto) é assumido. STALLED: o agendador não executa (`skipped`); só o retry humano
 * (origem HUMAN_RETRY, D250) zera as falhas e segue.
 */
async function acquireLease({ connectionId, stream, cursorKind, workerId, origin }, ctx, params) {
  if (!STREAM_RE.test(String(stream || ''))) throw AppError.badRequest('Nome de fluxo inválido (minúsculas, números, ponto, hífen e sublinhado).', 'INTEGRATION_SYNC_STREAM_INVALID');
  const tipo = cursorKind || 'TOKEN';
  if (!CURSOR_KINDS.includes(tipo)) throw AppError.badRequest(`Tipo de cursor inválido. Use: ${CURSOR_KINDS.join(', ')}.`, 'INTEGRATION_SYNC_CURSOR_KIND_INVALID');
  if (!workerId) throw AppError.badRequest('Informe o identificador do worker.', 'INTEGRATION_SYNC_WORKER_REQUIRED');

  return tenantTx(ctx, async (transaction) => {
    const conexao = await carregarConexaoAtiva(connectionId, transaction);
    await sequelize.query(
      `INSERT INTO "integration"."sync_cursors" (group_id, company_id, connection_id, stream, cursor_kind)
       VALUES (:g, :c, :conn, :stream, :kind) ON CONFLICT (connection_id, stream) DO NOTHING`,
      { replacements: { g: conexao.groupId, c: conexao.companyId, conn: conexao.id, stream, kind: tipo }, transaction }
    );
    const cursor = await IntegrationSyncCursor.findOne({ where: { connectionId, stream }, transaction, lock: transaction.LOCK.UPDATE });
    const agora = await agoraDoBanco(transaction);
    if (cursor.status === 'RUNNING' && cursor.leaseExpiresAt && cursor.leaseExpiresAt > agora) {
      throw AppError.conflict('Já existe uma sincronização em andamento para este fluxo.', 'INTEGRATION_SYNC_ALREADY_RUNNING');
    }
    const humano = origin === ORIGINS.HUMAN_RETRY;
    if (cursor.status === 'STALLED' && !humano) return { skipped: 'STALLED', cursor: cursor.toJSON(), conexao: conexao.toJSON() };

    const antes = visao(cursor);
    const retomando = cursor.status === 'STALLED';
    cursor.status = 'RUNNING';
    cursor.leaseOwner = workerId;
    cursor.leaseExpiresAt = new Date(agora.getTime() + params.leaseS * 1000);
    cursor.lastAttemptAt = agora;
    if (retomando) cursor.consecutiveFailures = 0;
    await cursor.save({ transaction });
    await auditarCursor(ctx, antes, cursor, retomando ? 'Retry humano de fluxo parado (STALLED): falhas zeradas.' : 'Lease adquirido para o ciclo de sincronização.', transaction);
    return { skipped: null, cursor: cursor.toJSON(), conexao: conexao.toJSON() };
  });
}

module.exports = { acquireLease, agoraDoBanco };
