'use strict';

const { IntegrationDispatch } = require('../../../../models');
const { CHANNEL_META } = require('../adapters/channels');
const jobs = require('./schedule.jobs');

const SYSTEM_APPROVER = 'SYSTEM_AUTOPUBLISH:';
const isSocial = (channel) => CHANNEL_META[channel].family === 'SOCIAL';

/**
 * Redes sociais (M9-D239 → M9-D410): o agendamento de um canal social cria o envio da rede no módulo de integrações sociais (`publishToSocial`), com a
 * chave sha256(conteúdo|versão|rede|horário) e `next_attempt_at` = horário. A "rede" do módulo social é a conexão: canais sociais que usam a mesma conexão
 * dividem o envio (a chave é a mesma), e cada canal segue com o seu job. Conteúdo aprovado por regra (SYSTEM_AUTOPUBLISH) entra no modo AUTO; o resto, MANUAL.
 * A falha de enfileirar UMA rede marca só o job dela como FAILED (erro isolado por canal); erro da porta (aprovação, kill switch) sobe e desfaz o agendamento.
 * A função do módulo social é lida na hora da chamada (nada de referência guardada).
 */
async function enqueueSocial({ tenant, actor, item, version, created, when }, transaction) {
  const social = created.filter((j) => isSocial(j.channel));
  if (social.length === 0) return [];
  const connectionIds = [...new Set(social.map((j) => j.connectionId))];
  const mode = String(version.approved_by || '').startsWith(SYSTEM_APPROVER) ? 'AUTO' : 'MANUAL';
  const ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: actor || null };
  const result = await require('../../../integrations/social').publishToSocial(ctx, { contentItemId: item.id, connectionIds, scheduledAt: when, mode, transaction });
  const failed = [];
  for (const r of result.results.filter((x) => !x.ok)) {
    for (const job of social.filter((j) => j.connectionId === r.connectionId)) {
      await jobs.setStatus(job.id, 'FAILED', r.code, actor, transaction);
      job.status = 'FAILED';
      failed.push({ jobId: job.id, channel: job.channel, code: r.code });
    }
  }
  return failed;
}

/**
 * Cancela os envios sociais ainda PENDING (ou esperando nova tentativa) do job cancelado. Se outro job ativo da mesma versão usa a mesma conexão, o envio é
 * dele também e fica. Envio que já saiu (SENDING ou adiante) não se cancela aqui. Devolve os ids cancelados.
 */
async function cancelSocialDispatches({ tenant, actor, job, itemId }, transaction) {
  if (!isSocial(job.channel) || !job.connection_id) return [];
  const shared = (await jobs.statusesOfVersion(job.content_version_id, transaction)).some((j) => j.id !== job.id && j.connection_id === job.connection_id && jobs.ACTIVE.includes(j.status));
  if (shared) return [];
  const { applyTransition } = require('../../../integrations/dispatch/dispatch.transition');
  const { parseContentRef } = require('../../../integrations/social');
  const rows = await IntegrationDispatch.findAll({
    where: { companyId: tenant.companyId, connectionId: job.connection_id, aggregateId: itemId, operation: 'publishPost', status: ['PENDING', 'RETRY_WAIT'] },
    transaction, lock: transaction.LOCK.UPDATE,
  });
  const ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: actor || null };
  const cancelled = [];
  for (const row of rows) {
    const ref = parseContentRef((row.payloadSnapshot || {}).contentRef);
    if (!ref || ref.versionId !== job.content_version_id || row.externalResourceId) continue;
    await applyTransition(ctx, row, 'CANCELLED', {}, { motivo: 'Publicação cancelada no Marketing: o envio da rede foi cancelado.' }, transaction);
    cancelled.push(row.id);
  }
  return cancelled;
}

module.exports = { enqueueSocial, cancelSocialDispatches, isSocial, SYSTEM_APPROVER };
