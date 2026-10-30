'use strict';

const { isOutboundBlocked } = require('../../killswitch.state');
const { resolveChannelConnection } = require('../schedule/schedule.connection');
const { cancelPendingDispatches, isSocial } = require('../schedule/schedule.social');
const repo = require('./worker.repository');
const { checkApproval } = require('./worker.content');
const { transition } = require('./worker.record');
const circuit = require('../adapters/circuit.gate');
const { isChannelReleased } = require('../adapters/release/channelAccess');

/**
 * A conexão do canal ainda atende? Devolve { blocker } (recusa 409 ou circuito aberto: o job não é enviado agora e não gasta tentativa) ou { circuit: { connectionId, probe } }.
 * O circuit breaker é o do framework de Integrações (M9-D217): aberto dentro do cooldown segura; vencido o cooldown, meia-abre e deixa passar só as chamadas de teste (M9-D442).
 */
async function connectionGate(ctx, job) {
  try {
    const connection = await resolveChannelConnection({ tenant: ctx.tenant, actor: null, channel: job.channel, transaction: ctx.transaction, circuitAware: true });
    const gateCtx = { tenant: ctx.tenant, transaction: ctx.transaction, now: ctx.now };
    if (await circuit.coolingDown(connection.id, gateCtx)) return { blocker: 'MKT_CHANNEL_CIRCUIT_OPEN' };
    // No sandbox o circuito é admitido aqui (vaga de teste na meia-abertura) e o resultado volta em applySend; em produção o cliente HTTP do bloco B admite na chamada.
    if (await isChannelReleased(job.channel, ctx.tenant, ctx.transaction)) return { circuit: null };
    const verdict = await circuit.admit(connection.id, gateCtx);
    if (!verdict.allowed) return { blocker: 'MKT_CHANNEL_CIRCUIT_OPEN' };
    return { circuit: { connectionId: connection.id, probe: verdict.probe } };
  } catch (err) {
    if (err && err.code === 'MKT_CHANNEL_CONNECTION_INACTIVE') return { blocker: err.code };
    throw err;
  }
}

/** Aprovação invalidada depois do agendamento: o job é CANCELLED (o item volta a ser decidido por quem aprova) e nada sai. */
async function cancelInvalidated(ctx, job, reason) {
  await transition(ctx, job, { status: 'CANCELLED', lastErrorCode: 'MKT_APPROVAL_INVALIDATED', nextAttemptAt: null }, { action: 'marketing.publication.cancel', reason: `Aprovação invalidada (${reason}); a publicação foi cancelada.` });
}

const noteBlock = async (job, code, transaction) => {
  if (job.last_error_code !== code) await repo.patch(job.id, { lastErrorCode: code }, transaction);
};

/**
 * Pega os jobs vencidos (M9-D411 item 1): PENDING com scheduled_at e next_attempt_at vencidos, até `params.batch`, travados com FOR UPDATE SKIP LOCKED (dois workers nunca
 * pegam o mesmo). Antes de cada job: kill switch global, do canal ou da campanha (ligado ou ilegível: o job fica PENDING, sem cancelar nem gastar tentativa, e entra no
 * ciclo seguinte à reativação), aprovação (approved_hash) e conexão. Aprovado: RUNNING com attempts + 1. A leitura segue por páginas, de modo que job segurado não ocupa o lote.
 * O envio da rede criado no agendamento (porta de aprovação do módulo social) sai de cena: o worker envia pelo canal.
 */
async function claimDue(ctx) {
  const claimed = [];
  const skipped = { killSwitch: 0, connection: 0, cancelled: 0 };
  let after = null;
  while (claimed.length < ctx.params.batch) {
    const rows = await repo.selectDue({ now: ctx.now, limit: ctx.params.batch, after }, ctx.transaction);
    if (rows.length === 0) break;
    for (const job of rows) {
      if (claimed.length >= ctx.params.batch) break;
      const blocked = await isOutboundBlocked(ctx.tenant, { channel: job.channel, campaignId: job.campaign_id }, ctx.transaction);
      if (blocked.blocked) { skipped.killSwitch += 1; continue; }
      const approval = await checkApproval(job, ctx.transaction);
      if (!approval.ok) { await cancelInvalidated(ctx, job, approval.reason); skipped.cancelled += 1; continue; }
      const gate = await connectionGate(ctx, job);
      if (gate.blocker) { await noteBlock(job, gate.blocker, ctx.transaction); skipped.connection += 1; continue; }
      if (isSocial(job.channel) && job.connection_id) await cancelPendingDispatches({ tenant: ctx.tenant, actor: null, job: { ...job, content_version_id: job.content_version_id }, itemId: job.item_id }, ctx.transaction);
      await repo.patch(job.id, { status: 'RUNNING', attempts: job.attempts + 1, startedAt: ctx.now, nextAttemptAt: null, lastErrorCode: null }, ctx.transaction);
      ctx.touched.add(job.item_id);
      claimed.push({ ...job, status: 'RUNNING', attempts: job.attempts + 1, started_at: ctx.now, circuit: gate.circuit });
    }
    const last = rows[rows.length - 1];
    if (rows.length < ctx.params.batch) break;
    after = { at: last.next_attempt_at || last.scheduled_at, id: last.id };
  }
  return { claimed, skipped };
}

module.exports = { claimDue };
