'use strict';

const repo = require('./pipeline.repository');
const guard = require('./approval.guard');
const { assertSourceFresh } = require('./sourceStale');
const { TEMPLATE_CHANNELS } = require('./template.constants');
const { parseWhen } = require('./pipeline.time');
const { readMinLeadMinutes } = require('./pipeline.settings');
const { scheduleTooSoon, contentInvalid } = require('./pipeline.errors');
const { loadLocked, readCheck, newCheck, hashInput } = require('./pipeline.core');
const { getSchedulePort } = require('./pipeline.schedulePort');

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

/** O serviço de jobs da área de publicações, entregue pela porta de agendamento (as áreas só se tocam pelo index, sem ciclo). */
const publications = () => getSchedulePort();

/**
 * M9-D406 função 7 / M9-D410 — schedulePublication(contentItem, channels, when): confere a fonte (M9-D405) e a aprovação (M9-D404) e cria um
 * publication_job por canal com idempotency_key, depois das pré-condições (kill switch, campos públicos, conexão do canal). Aprovação invalidada não
 * lança aqui: o chamador confirma a invalidação (commit) e só então responde o 409 (a transação com throw desfaria a própria invalidação).
 */
async function scheduleStep({ item, version, tenant, actor, transaction }, prepared) {
  await assertSourceFresh(item.id, tenant, transaction);
  const check = await guard.checkApproval(tenant, actor, item.id, transaction, { origin: 'SCHEDULE' });
  if (check.invalidated) return { abort: { approvalInvalidated: check } };
  const jobs = await publications().scheduleJobs({ tenant, actor, item, version, prepared }, transaction);
  return {
    ok: true,
    detalhes: { when: prepared.when.toISOString(), channels: prepared.channels, jobIds: jobs.map((j) => j.id) },
    extra: { jobs },
  };
}

/**
 * Item que já está SCHEDULED: acrescenta canal, repete o pedido (replay) ou recusa outro horário para o mesmo canal (409 MKT_JOB_ALREADY_ACTIVE). Mesmas
 * conferências do primeiro agendamento. O item continua SCHEDULED.
 */
async function scheduleMore({ tenant, actor, itemId }, prepared, transaction) {
  const { item, version } = await loadLocked(itemId, transaction);
  await assertSourceFresh(item.id, tenant, transaction);
  const check = await guard.checkApproval(tenant, actor, item.id, transaction, { origin: 'SCHEDULE' });
  if (check.invalidated) {
    const fresh = await repo.lockItem(item.id, transaction);
    return { itemId: item.id, status: fresh.status, versionId: version.id, step: null, replay: false, approvalInvalidated: check };
  }
  const jobs = await publications().scheduleJobs({ tenant, actor, item, version, prepared }, transaction);
  const replay = jobs.every((j) => j.replay);
  const step = replay ? readCheck(version, 'schedule') : await refreshScheduleCheck({ version, actor, prepared }, transaction);
  return { itemId: item.id, status: item.status, versionId: version.id, step, replay, jobs };
}

/** O detalhe do passo `schedule` reflete o último agendamento (quando e canais) e lista todos os jobs da versão; repetir o pedido (replay) não o altera. */
async function refreshScheduleCheck({ version, actor, prepared }, transaction) {
  const all = await repo.listJobs(version.id, transaction);
  const input = { channels: prepared.channels, when: prepared.when.toISOString() };
  const check = newCheck(true, { when: input.when, channels: prepared.channels, jobIds: all.map((j) => j.id) }, hashInput('schedule', version, input));
  await repo.writeCheck(version.id, 'schedule', check, actor, transaction);
  return check;
}

module.exports = { prepareSchedule, scheduleStep, scheduleMore };
