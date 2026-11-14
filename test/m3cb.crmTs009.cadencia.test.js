'use strict';

// Livro do Marco 3 §19 CRM-TS-009 ("Opt-out — Cadência tenta enviar — Bloqueado"), §11 ("Lead sem retorno entra em cadência configurável";
// "Cliente que pediu para não receber contato tem cadências suspensas") e Guia §15 ("Opt-out impede cadência"). A cadência é a de verdade:
// a automação LEAD-SEM-RETORNO (1/3/7 dias) rodada pelo runner de Marketing, às 09:00 de São Paulo. O opt-out é registrado pelo CADASTRO DA
// PESSOA (POST /people/:id/consents -> personConsents.recordConsent), o caminho do CRM, e não direto na supressão.
// Banco descartável: node scripts/withDisposableDb.js --port <p> -- ... node --test test/m3cb.crmTs009.cadencia.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../src/models');
const personConsents = require('../src/features/people/personConsents.service');
require('../src/features/marketing/suppression'); // registra o tratador do opt-out (M9-D419), como no boot do app
const env = require('./marco9/_helpers/mktLeads');

let A; let offVault;
before(async () => { ({ tenantA: A } = await env.prepararTenants()); offVault = env.useTempSecretStore(); });
after(async () => { offVault(); await sequelize.close(); });

const CODE = 'LEAD-SEM-RETORNO';
const at9 = (day) => new Date(`${day}T12:00:00.000Z`);
const FIRST_CONTACT = new Date('2026-11-01T15:00:00.000Z');
const inRollback = (fn) => env.withRollbackTenantTransaction(A, fn);
const followUps = async (t, personId) => (await env.outbound(t, personId)).filter((m) => m.purpose === 'ACOMPANHAMENTO');
const runsOf = (t, personId) => env.q(t, 'SELECT * FROM marketing.automation_runs WHERE subject_id = :p ORDER BY created_at', { p: personId });

async function tick(t, personId, day) {
  const out = await env.runner.runScheduleTick(A, t, { now: at9(day), mode: 'SANDBOX' });
  await env.retime(t, personId, at9(day));
  return out;
}
async function silentLead(t) {
  await env.install(t, A, CODE);
  const lead = await env.lead(t, A, { source: 'FORM' });
  await env.contact(t, A, lead.personId, FIRST_CONTACT, 'OUTBOUND');
  return lead;
}

test('CRM-TS-009 Opt-out — Cadência tenta enviar — Bloqueado: opt-out registrado na pessoa suspende a cadência do lead sem retorno', async () => {
  await inRollback(async (t) => {
    const lead = await silentLead(t);
    await personConsents.recordConsent(lead.personId, { channel: 'EMAIL', purpose: 'ALL', status: 'OPT_OUT' }, A.userId, t);
    await tick(t, lead.personId, '2026-11-02');
    await tick(t, lead.personId, '2026-11-04');
    assert.equal((await followUps(t, lead.personId)).length, 0, 'nenhum acompanhamento sai para quem pediu para não receber');
    const runs = await runsOf(t, lead.personId);
    assert.ok(runs.length >= 1, 'a cadência TENTOU enviar (a run existe)');
    assert.ok(runs.every((r) => r.blocked_reason === 'SUPPRESSED'), JSON.stringify(runs.map((r) => r.blocked_reason)));
  });
});

test('CRM-TS-009 controle: sem opt-out, a mesma cadência envia o acompanhamento (o bloqueio acima é do opt-out, não da cadência parada)', async () => {
  await inRollback(async (t) => {
    const lead = await silentLead(t);
    await tick(t, lead.personId, '2026-11-02');
    assert.equal((await followUps(t, lead.personId)).length, 1);
  });
});

test('CRM-TS-009 o opt-out de um canal pela pessoa grava o consentimento no CRM e a supressão do Marketing no mesmo instante', async () => {
  await inRollback(async (t) => {
    const lead = await silentLead(t);
    await personConsents.recordConsent(lead.personId, { channel: 'EMAIL', purpose: 'ALL', status: 'OPT_OUT' }, A.userId, t);
    const [consent] = await env.q(t, "SELECT status FROM people.communication_consents WHERE person_id = :p AND channel = 'EMAIL' ORDER BY recorded_at DESC LIMIT 1", { p: lead.personId });
    assert.equal(consent.status, 'OPT_OUT');
    const supressao = await env.q(t, "SELECT channel, reason FROM marketing.suppression_list WHERE person_id = :p AND deleted_at IS NULL", { p: lead.personId });
    assert.ok(supressao.some((s) => s.channel === 'EMAIL' && s.reason === 'OPT_OUT'), JSON.stringify(supressao));
  });
});
