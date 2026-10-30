'use strict';

// M9-D423 — as pendências que a série acompanha: resolução e cancelamento encerram a série, mensagem neutra, supressão, eventos inválidos e isolamento entre empresas.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const r = require('../_helpers/mktRestricao');

let tenant;
let tenantB;
before(async () => { ({ tenantA: tenant, tenantB } = await r.prepararTenants()); });
after(async () => { await sequelize.close(); });
const inTx = (fn) => withRollbackTenantTransaction(tenant, fn);
const OPEN_DAY = '2026-11-01';
const day = (n) => r.addDays(OPEN_DAY, n);
const statusOf = async (t, ref) => (await r.q(t, 'SELECT status, closed_at FROM marketing.reminder_pendings WHERE pending_ref = :ref', { ref }))[0];

test('pendencia_resolvida_encerra_serie: nenhum lembrete depois da resolução em 20/11', async () => {
  await inTx(async (t) => {
    await r.install(t, tenant);
    const person = await r.person(t, tenant);
    const ref = await r.openPending(t, tenant, person);
    await r.tick(t, tenant, day(7));
    await r.tick(t, tenant, day(14));
    assert.equal((await r.sentOn(t, person)).length, 2);
    await r.fire(t, tenant, 'crm.pending.resolved', { pendingId: ref });
    assert.equal((await statusOf(t, ref)).status, 'RESOLVED');
    for (let n = 15; n <= 70; n += 1) await r.tick(t, tenant, day(n));
    assert.equal((await r.sentOn(t, person)).length, 2, 'nenhum lembrete depois de resolvida');
    assert.equal((await r.runsOfPerson(t, person)).length, 2, 'nem expiração: a série acabou');
  });
});

test('pendencia_cancelada_tambem_encerra_a_serie_e_evento_repetido_nao_reabre', async () => {
  await inTx(async (t) => {
    await r.install(t, tenant);
    const person = await r.person(t, tenant);
    const ref = await r.openPending(t, tenant, person);
    await r.fire(t, tenant, 'crm.pending.cancelled', { pendingId: ref });
    assert.equal((await statusOf(t, ref)).status, 'CANCELLED');
    await r.openPending(t, tenant, person, { ref });
    assert.equal((await statusOf(t, ref)).status, 'CANCELLED', 'abrir de novo o mesmo id não reabre');
    assert.equal((await r.tick(t, tenant, day(7))).created, 0);
    assert.equal((await r.q(t, 'SELECT count(*)::int AS n FROM marketing.reminder_pendings WHERE pending_ref = :ref', { ref }))[0].n, 1);
  });
});

test('preview_nao_revela_motivo_sensivel: restrição de crédito nunca aparece na mensagem nem no resultado da run', async () => {
  await inTx(async (t) => {
    await r.install(t, tenant);
    const person = await r.person(t, tenant);
    await r.openPending(t, tenant, person, { kind: 'RESTRICTION' });
    await r.tick(t, tenant, day(7));
    const [message] = await r.sentOn(t, person);
    assert.match(message.body, /pendência no seu processo/i);
    assert.doesNotMatch(message.body, /restri|crédito|credito|negativ|spc|serasa|dívida|divida|score/i);
    const [run] = await r.runsOfPerson(t, person);
    assert.doesNotMatch(JSON.stringify(run.actions_result), /RESTRICTION|restri/i, 'o tipo da pendência não vai para a run');
  });
});

test('sem_consentimento_de_canal_a_run_fica_bloqueada: opt-out suprime o lembrete (SUPPRESSED) e a série segue sem enviar', async () => {
  await inTx(async (t) => {
    await r.install(t, tenant);
    const person = await r.person(t, tenant);
    await r.openPending(t, tenant, person);
    await r.optOut(t, tenant, person, 'EMAIL');
    await r.tick(t, tenant, day(7));
    const [run] = await r.runsOfPerson(t, person);
    assert.equal(run.status, 'BLOCKED');
    assert.equal(run.blocked_reason, 'SUPPRESSED');
    assert.equal((await r.sentOn(t, person)).length, 0);
  });
});

test('evento_de_pendencia_invalido_e_ignorado_sem_travar_o_outbox', async () => {
  await inTx(async (t) => {
    const person = await r.person(t, tenant);
    const bad = [{ personId: person, kind: 'DOCUMENT', sourceType: 'CONTRACT' }, { pendingId: 'x', personId: person, kind: 'OUTRO', sourceType: 'CONTRACT' },
      { pendingId: 'x', personId: r.uid(), kind: 'DOCUMENT', sourceType: 'CONTRACT' }, { pendingId: 'y'.repeat(81), personId: person, kind: 'DOCUMENT', sourceType: 'CONTRACT' }];
    for (const payload of bad) assert.deepEqual(await r.fire(t, tenant, 'crm.pending.opened', payload), { ignored: true });
    assert.equal((await r.q(t, 'SELECT count(*)::int AS n FROM marketing.reminder_pendings WHERE person_id = :p', { p: person }))[0].n, 0);
  });
});

test('a_lista_de_pendencias_e_isolada_por_empresa: a outra empresa não enxerga a pendência nem lembra a pessoa', async () => {
  await inTx(async (t) => {
    await r.install(t, tenant);
    const person = await r.person(t, tenant);
    const ref = await r.openPending(t, tenant, person);
    const seen = await r.asTenant(t, tenant, tenantB, () => r.q(t, 'SELECT count(*)::int AS n FROM marketing.reminder_pendings WHERE pending_ref = :ref', { ref }));
    assert.equal(seen[0].n, 0);
    const foreign = await r.asTenant(t, tenant, tenantB, () => r.tick(t, tenantB, day(7)));
    assert.equal(foreign.created, 0, 'a empresa B não tem automação nem pendência');
    assert.equal((await r.runsOfPerson(t, person)).length, 0);
  });
});

test('a_tabela_de_pendencias_tem_RLS_FORCE_politica_e_grant_do_runtime', async () => {
  await inTx(async (t) => {
    const [cls] = await r.q(t, "SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'marketing.reminder_pendings'::regclass");
    assert.deepEqual([cls.rls, cls.forced], [true, true]);
    assert.ok((await r.q(t, "SELECT 1 AS ok FROM pg_policy WHERE polrelid = 'marketing.reminder_pendings'::regclass"))[0]);
    const [grants] = await r.q(t, `SELECT has_table_privilege('nayara_runtime', 'marketing.reminder_pendings', 'SELECT') AS sel, has_table_privilege('nayara_runtime', 'marketing.reminder_pendings', 'INSERT') AS ins,
      has_table_privilege('nayara_runtime', 'marketing.reminder_pendings', 'UPDATE') AS upd`);
    assert.deepEqual([grants.sel, grants.ins, grants.upd], [true, true, true]);
    await assert.rejects(r.q(t, "INSERT INTO marketing.reminder_pendings (group_id, company_id, pending_ref, person_id, kind, source_type, opened_at, status) VALUES (:g, :c, 'x', :p, 'DOCUMENT', 'CONTRACT', now(), 'RESOLVED')",
      { g: tenant.groupId, c: tenant.companyId, p: await r.person(t, tenant) }), /mkt_reminder_pendings_closed_chk/);
  });
});
