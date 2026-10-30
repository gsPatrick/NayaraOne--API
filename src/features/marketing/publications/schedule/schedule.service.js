'use strict';

const jobs = require('./schedule.jobs');
const { assertSchedulable } = require('./schedule.preconditions');
const { enqueueSocial } = require('./schedule.social');
const { jobAlreadyActive } = require('./schedule.errors');

/** Chave de idempotência do job: pub:{versão}:{CANAL}:{instante UTC}. Reagendar o mesmo canal no mesmo instante não duplica (UNIQUE no banco). */
const jobKey = (versionId, channel, when) => `pub:${versionId}:${channel}:${when.toISOString()}`;

/**
 * Cria (ou devolve) o job de cada canal (M9-D410 itens 1 e 3). Com o item travado: a chave já existente devolve o job gravado (`replay`); job CANCELLED com a
 * mesma chave volta a PENDING (mesmo post, mesmo horário, depois de cancelar); outro job ATIVO da mesma versão e canal, em outro horário, é 409 MKT_JOB_ALREADY_ACTIVE.
 */
async function createJobs({ tenant, actor, version, prepared, connections }, transaction) {
  const out = [];
  for (const channel of prepared.channels) {
    const key = jobKey(version.id, channel, prepared.when);
    const connection = connections[channel];
    const values = { versionId: version.id, channel, adapterCode: connection.providerCode, connectionId: connection.id, idempotencyKey: key, scheduledAt: prepared.when };
    const existing = await jobs.findByKey(tenant.companyId, key, transaction);
    if (existing && existing.status !== 'CANCELLED') {
      out.push({ id: existing.id, channel, status: existing.status, replay: true, connectionId: existing.connection_id });
      continue;
    }
    const active = await jobs.findActive(version.id, channel, transaction);
    if (active) throw jobAlreadyActive({ channel, jobId: active.id, scheduledAt: active.scheduled_at });
    const row = existing ? await jobs.revive(existing.id, values, actor, transaction) : await jobs.insert(tenant, actor, values, transaction);
    out.push({ id: row.id, channel, status: row.status, replay: false, connectionId: connection.id });
  }
  return out;
}

/**
 * Agendamento do item travado: pré-condições (kill switch, campos públicos, conexão), jobs por canal e o envio das redes sociais. Falha de uma rede marca só o
 * job dela como FAILED. Devolve a lista de jobs { id, channel, status, replay } na ordem dos canais pedidos.
 */
async function scheduleJobs({ tenant, actor, item, version, prepared }, transaction) {
  const connections = await assertSchedulable({ tenant, actor, item, version, channels: prepared.channels, transaction });
  const created = await createJobs({ tenant, actor, version, prepared, connections }, transaction);
  await enqueueSocial({ tenant, actor, item, version, created: created.filter((j) => !j.replay), when: prepared.when }, transaction);
  return created.map(({ id, channel, status, replay }) => ({ id, channel, status, replay }));
}

module.exports = { scheduleJobs, createJobs, jobKey };
