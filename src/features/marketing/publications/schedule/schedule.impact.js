'use strict';

const { registerProvider } = require('../../../../shared/destructive-actions/registry');
const { rows, blocker } = require('../../../../shared/destructive-actions/providers/sql');
const { refusalOf } = require('./schedule.cancel');
const jobs = require('./schedule.jobs');

const BLOCKER_TEXT = Object.freeze({
  STATUS_RUNNING: 'a publicação está em andamento',
  STATUS_PUBLISHED: 'a publicação já foi feita',
  STATUS_FAILED: 'a publicação já terminou com falha',
  STATUS_CANCELLED: 'a publicação já foi cancelada',
  UNKNOWN_NOT_RECONCILED: 'o resultado ainda não foi conferido na rede (reconciliação pendente)',
});

/** Impacto de cancelar a publicação agendada (linha 18 do inventário): canal e horário; impedimento se não estiver mais PENDING (ou UNKNOWN já reconciliado). */
async function publicationCancel({ id, transaction }) {
  const [job] = await rows(transaction,
    `SELECT j.id, j.channel, j.status, j.scheduled_at, j.content_version_id, i.title FROM marketing.publication_jobs j
       JOIN marketing.content_versions v ON v.id = j.content_version_id AND v.company_id = j.company_id
       JOIN marketing.content_items i ON i.id = v.content_item_id AND i.company_id = v.company_id
      WHERE j.id = :id AND j.deleted_at IS NULL`, { id });
  if (!job) throw require('./schedule.errors').jobNotFound();
  const refusal = await refusalOf(job, transaction);
  const siblings = (await jobs.statusesOfVersion(job.content_version_id, transaction)).filter((j) => j.id !== job.id && jobs.ACTIVE.includes(j.status));
  const scheduledAt = new Date(job.scheduled_at).toISOString();
  return {
    code: job.title,
    label: `Publicação de "${job.title}" em ${job.channel}`,
    impact: {
      counts: { channels: 1, otherActiveChannels: siblings.length },
      totalAmountCents: 0,
      blockers: refusal ? [blocker(refusal, `Não é possível cancelar: ${BLOCKER_TEXT[refusal] || refusal}.`)] : [],
      items: [{ type: 'PUBLICATION_JOB', id: job.id, label: `${job.channel} agendado para ${scheduledAt}` }],
    },
  };
}

registerProvider('marketing.publication.cancel', publicationCancel);

module.exports = { publicationCancel };
