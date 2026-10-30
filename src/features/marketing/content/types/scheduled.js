'use strict';

const { createTriggeredDraft } = require('./triggers.create');
const { listBirthdays, listPublicConstructions } = require('./queries');
const { readBirthdayTime } = require('./types.settings');
const { companyTimeZone, localParts, isLeapYear, minutesOf } = require('./localTime');

/**
 * M9-D409 — rascunhos que nascem de relógio, não de evento. BIRTHDAY_RELATIONSHIP: todo dia, a partir da hora configurada (padrão
 * 08:00) no fuso da empresa (America/Sao_Paulo), um rascunho por aniversariante do dia; quem nasceu em 29/02 é lembrado em 28/02
 * nos anos não bissextos. NAYARA_CONSTRUCTION: um rascunho por (obra, etapa pública) — o marco público da obra. As duas rotinas são
 * idempotentes (chave do dia / da etapa), então rodar de novo, ou dois processos ao mesmo tempo, nunca duplica.
 */
async function runBirthdayDrafts(tenant, transaction, now = new Date(), { doneDate = null } = {}) {
  const zone = await companyTimeZone(tenant, transaction);
  const today = localParts(now, zone);
  if (today.minutes < minutesOf(await readBirthdayTime(tenant, transaction))) return { due: false, created: 0, skipped: 0 };

  if (doneDate === today.date) return { due: true, date: today.date, created: 0, skipped: 0 }; // o job já varreu o dia
  const days = [{ day: today.day, month: today.month }];
  if (today.month === 2 && today.day === 28 && !isLeapYear(today.year)) days.push({ day: 29, month: 2 });
  const summary = { due: true, date: today.date, created: 0, skipped: 0 };
  for (const when of days) {
    for (const person of await listBirthdays(when, tenant, transaction)) {
      const out = await createTriggeredDraft({
        type: 'BIRTHDAY_RELATIONSHIP', sourceEntityType: 'person', sourceEntityId: person.personId, triggerEventId: `birthday:${today.date}`,
      }, tenant, transaction);
      if (out.created) summary.created += 1; else summary.skipped += 1;
    }
  }
  return summary;
}

async function runConstructionDrafts(tenant, transaction) {
  const summary = { created: 0, skipped: 0 };
  for (const { projectId, stage } of await listPublicConstructions(tenant, transaction)) {
    const out = await createTriggeredDraft({
      type: 'NAYARA_CONSTRUCTION', sourceEntityType: 'construction', sourceEntityId: projectId, triggerEventId: `stage:${stage}`.slice(0, 150),
    }, tenant, transaction);
    if (out.created) summary.created += 1; else summary.skipped += 1;
  }
  return summary;
}

module.exports = { runBirthdayDrafts, runConstructionDrafts };
