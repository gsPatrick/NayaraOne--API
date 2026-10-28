'use strict';

const repo = require('./pipeline.repository');
const guard = require('./approval.guard');
const { assertSourceFresh } = require('./sourceStale');
const { TEMPLATE_CHANNELS } = require('./template.constants');
const { parseWhen } = require('./pipeline.time');
const { readMinLeadMinutes } = require('./pipeline.settings');
const { scheduleTooSoon, contentInvalid } = require('./pipeline.errors');

/** Chave de idempotência do job: pub:{versão}:{CANAL}:{instante}. Reagendar o mesmo canal no mesmo instante não duplica. */
const jobKey = (versionId, channel, when) => `pub:${versionId}:${channel}:${when.toISOString()}`;

function normalizeChannels(channels) {
  const list = Array.isArray(channels) ? channels.map((c) => String(c).trim().toUpperCase()).filter(Boolean) : [];
  const unique = [...new Set(list)];
  const unknown = unique.filter((c) => !TEMPLATE_CHANNELS.includes(c));
  if (unique.length === 0 || unknown.length > 0) {
    throw contentInvalid('Informe ao menos um canal válido para o agendamento.', { channels: unique, unknown });
  }
  return unique;
}

/** Valida antecedência mínima (parâmetro da empresa) e canais ANTES de tocar no item. */
async function prepareSchedule(tenant, input, transaction, now) {
  const channels = normalizeChannels(input.channels);
  const when = await parseWhen(input.when, tenant, transaction);
  const minMinutes = await readMinLeadMinutes(tenant, transaction);
  const earliest = new Date((now || new Date()).getTime() + minMinutes * 60000);
  if (when < earliest) throw scheduleTooSoon({ when: when.toISOString(), minMinutes, earliest: earliest.toISOString() });
  return { channels, when };
}

/**
 * M9-D406 função 7 — schedulePublication(contentItem, channels, when): confere a fonte (M9-D405) e a aprovação (M9-D404) e cria um
 * publication_job por canal com idempotency_key. Aprovação invalidada não lança aqui: o chamador confirma a invalidação (commit)
 * e só então responde o 409 (a transação com throw desfaria a própria invalidação).
 */
async function scheduleStep({ item, version, tenant, actor, transaction }, prepared) {
  await assertSourceFresh(item.id, tenant, transaction);
  const check = await guard.checkApproval(tenant, actor, item.id, transaction, { origin: 'SCHEDULE' });
  if (check.invalidated) return { abort: { approvalInvalidated: check } };
  const jobs = [];
  for (const channel of prepared.channels) {
    jobs.push(await repo.insertJob(tenant, actor, {
      versionId: version.id, channel, adapterCode: 'sandbox', idempotencyKey: jobKey(version.id, channel, prepared.when), scheduledAt: prepared.when,
    }, transaction));
  }
  return {
    ok: true,
    detalhes: { when: prepared.when.toISOString(), channels: prepared.channels, jobIds: jobs.map((j) => j.id) },
    extra: { jobs: jobs.map((j) => ({ id: j.id, channel: j.channel, status: j.status, replay: j.replay })) },
  };
}

module.exports = { prepareSchedule, scheduleStep, jobKey };
