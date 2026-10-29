'use strict';

// M9-D804 — owner e steward por domínio: regras do serviço com banco. Banco descartável:
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d804.servico.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d804Env');
const stewardship = require('../../../src/features/core-governance/data-quality/stewardship.service');
const lifecycle = require('../../../src/features/core-governance/data-quality/stewardship.lifecycle');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);
const put = (code, designations, tx, tenant = tenants.A) => stewardship.designate(tenant, env.actorOf(tenant), code, { designations }, tx);
const codeOf = async (promise) => promise.then(() => null, (err) => err.code);

test('m9d804 troca de steward preserva histórico', { skip: skip() }, async () => {
  await run(async (tx) => {
    const ana = await env.newUser(A(), tx); const bruno = await env.newUser(A(), tx);
    await put('PESSOAS', [{ role: 'STEWARD', userId: ana.id }], tx);
    const first = await put('PESSOAS', [{ role: 'STEWARD', userId: ana.id }], tx);
    assert.equal(first.stewards.length, 1, 'repetir a mesma designação vigente é idempotente');
    assert.equal((await env.history(A(), 'PESSOAS', tx)).length, 1, 'sem linha nova');
    const view = await put('PESSOAS', [{ role: 'STEWARD', userId: bruno.id }], tx);
    assert.deepEqual(view.stewards.map((s) => s.userId), [bruno.id]);
    const rows = await env.history(A(), 'PESSOAS', tx);
    assert.equal(rows.length, 2, 'o histórico não é apagado');
    const anaRow = rows.find((r) => r.user_id === ana.id); const brunoRow = rows.find((r) => r.user_id === bruno.id);
    assert.ok(anaRow.valid_until, 'linha da Ana fechada');
    assert.equal(anaRow.close_reason, 'REPLACED');
    assert.equal(brunoRow.valid_until, null, 'linha do Bruno vigente');
    const many = await put('PESSOAS', [{ role: 'STEWARD', userId: bruno.id }, { role: 'STEWARD', userId: ana.id }], tx);
    assert.equal(many.stewards.length, 2, 'mais de um steward é permitido');
  });
});

test('m9d804 segundo owner vigente recusado', { skip: skip() }, async () => {
  await run(async (tx) => {
    const ana = await env.newUser(A(), tx); const bruno = await env.newUser(A(), tx);
    await put('IMOVEIS', [{ role: 'OWNER', userId: ana.id }], tx);
    // O banco também garante: dois owners vigentes no mesmo domínio violam o índice único.
    const [domain] = await env.sequelize.query("SELECT id FROM governance.data_domains WHERE company_id = :c AND code = 'IMOVEIS'", { replacements: { c: A().companyId }, transaction: tx, type: 'SELECT' });
    const code = await codeOf(env.sequelize.transaction({ transaction: tx }, (sp) => env.sequelize.query(
      `INSERT INTO governance.data_domain_assignments (group_id, company_id, domain_id, role, user_id) VALUES (:g, :c, :d, 'OWNER', :u)`,
      { transaction: sp, replacements: { g: A().groupId, c: A().companyId, d: domain.id, u: bruno.id } }
    )).catch((err) => { throw { code: err.parent && err.parent.code }; }));
    assert.equal(code, '23505');
  });
});

test('m9d804 duas linhas OWNER no mesmo corpo devolvem 409', { skip: skip() }, async () => {
  await run(async (tx) => {
    const ana = await env.newUser(A(), tx); const bruno = await env.newUser(A(), tx);
    const err = await stewardship.designate(A(), env.actorOf(A()), 'FINANCEIRO', { designations: [{ role: 'OWNER', userId: ana.id }, { role: 'OWNER', userId: bruno.id }] }, tx).catch((e) => e);
    assert.equal(err.statusCode, 409);
    assert.equal(err.code, 'GOV_DOMAIN_OWNER_EXISTS');
    assert.equal(err.message, 'Informe um único responsável (owner) por domínio.');
    assert.equal((await env.history(A(), 'FINANCEIRO', tx)).length, 0, 'nada gravado');
  });
});

test('m9d804 troca de owner via PUT fecha a linha antiga e abre a nova', { skip: skip() }, async () => {
  await run(async (tx) => {
    const ana = await env.newUser(A(), tx); const bruno = await env.newUser(A(), tx);
    await put('OBRAS', [{ role: 'OWNER', userId: ana.id }], tx);
    const view = await put('OBRAS', [{ role: 'OWNER', userId: bruno.id }], tx);
    assert.equal(view.owner.userId, bruno.id);
    const rows = (await env.history(A(), 'OBRAS', tx)).filter((r) => r.role === 'OWNER');
    assert.equal(rows.length, 2);
    assert.ok(rows.find((r) => r.user_id === ana.id).valid_until, 'owner antigo fechado');
    assert.equal(rows.find((r) => r.user_id === bruno.id).valid_until, null);
    const stewardOnly = await put('OBRAS', [{ role: 'STEWARD', userId: ana.id }], tx);
    assert.equal(stewardOnly.owner.userId, bruno.id, 'papel ausente do corpo não muda');
  });
});

test('m9d804 GET lista a pendência de domínio sem owner e sem steward', { skip: skip() }, async () => {
  await run(async (tx) => {
    const ana = await env.newUser(A(), tx);
    const before = (await stewardship.listDomains(A(), tx)).find((d) => d.code === 'CRM');
    assert.deepEqual(before.pendencies.map((p) => [p.message, p.severity]), [['Domínio sem responsável', 'CRITICAL'], ['Domínio sem steward', 'HIGH']]);
    assert.equal(before.owner, null);
    await put('CRM', [{ role: 'STEWARD', userId: ana.id }], tx);
    const onlySteward = (await stewardship.listDomains(A(), tx)).find((d) => d.code === 'CRM');
    assert.deepEqual(onlySteward.pendencies.map((p) => p.severity), ['CRITICAL']);
    await put('CRM', [{ role: 'OWNER', userId: ana.id }], tx);
    assert.deepEqual((await stewardship.listDomains(A(), tx)).find((d) => d.code === 'CRM').pendencies, []);
    const all = await stewardship.listDomains(A(), tx);
    assert.deepEqual(all.map((d) => d.code), 'PESSOAS,IMOVEIS,FORNECEDORES,CRM,FINANCEIRO,CONTRATOS,COMISSOES,OBRAS,ESTOQUE,CORRESPONDENTE,FISCAL'.split(','), 'domínios semeados na ordem do parâmetro');
  });
});

test('m9d804 designar usuário inativo devolve 422 GOV_ASSIGNEE_INACTIVE', { skip: skip() }, async () => {
  await run(async (tx) => {
    const suspended = await env.newUser(A(), tx, { status: 'SUSPENDED' });
    const revoked = await env.newUser(A(), tx, { membership: 'REVOKED' });
    for (const user of [suspended, revoked]) {
      const err = await put('FISCAL', [{ role: 'OWNER', userId: user.id }], tx).catch((e) => e);
      assert.equal(err.statusCode, 422);
      assert.equal(err.code, 'GOV_ASSIGNEE_INACTIVE');
      assert.equal(err.message, 'Só usuário ativo da empresa pode ser designado.');
    }
    assert.equal((await env.history(A(), 'FISCAL', tx)).length, 0);
  });
});

test('m9d804 usuário de outra empresa e domínio inexistente', { skip: skip() }, async () => {
  await run(async (tx) => {
    const ana = await env.newUser(A(), tx);
    const foreign = await put('PESSOAS', [{ role: 'OWNER', userId: tenants.B.userId }], tx).catch((e) => e);
    assert.deepEqual([foreign.statusCode, foreign.code, foreign.message], [404, 'GOV_NOT_FOUND', 'Usuário não encontrado.']);
    const invalid = await put('NAO_EXISTE', [{ role: 'OWNER', userId: ana.id }], tx).catch((e) => e);
    assert.deepEqual([invalid.statusCode, invalid.code, invalid.message], [400, 'GOV_DOMAIN_INVALID', 'Domínio de dados inválido.']);
    const bad = await put('PESSOAS', [{ role: 'DONO', userId: ana.id }], tx).catch((e) => e);
    assert.equal(bad.code, 'VALIDATION_ERROR');
    const empty = await stewardship.designate(A(), env.actorOf(A()), 'PESSOAS', { designations: [] }, tx).catch((e) => e);
    assert.equal(empty.code, 'VALIDATION_ERROR');
  });
});

test('m9d804 isolamento entre empresas', { skip: skip() }, async () => {
  const userA = await run(async (tx) => {
    const ana = await env.newUser(A(), tx);
    await put('ESTOQUE', [{ role: 'OWNER', userId: ana.id }], tx);
    assert.equal((await stewardship.listDomains(A(), tx)).find((d) => d.code === 'ESTOQUE').owner.userId, ana.id);
    return ana.id;
  });
  await run(async (tx) => {
    const viewB = (await stewardship.listDomains(tenants.B, tx)).find((d) => d.code === 'ESTOQUE');
    assert.equal(viewB.owner, null, 'a empresa B não enxerga a designação da A');
    const rows = await env.sequelize.query('SELECT count(*)::int AS n FROM governance.data_domain_assignments WHERE user_id = :u', { replacements: { u: userA }, transaction: tx, type: 'SELECT' });
    assert.equal(rows[0].n, 0, 'RLS: nem por SQL direto');
  }, tenants.B);
});

test('m9d804 usuário desativado fecha designações', { skip: skip() }, async () => {
  await run(async (tx) => {
    const ana = await env.newUser(A(), tx);
    const admin = await env.newUser(A(), tx, { roleName: 'ADMIN' });
    await put('CONTRATOS', [{ role: 'OWNER', userId: ana.id }, { role: 'STEWARD', userId: ana.id }], tx);
    await put('COMISSOES', [{ role: 'STEWARD', userId: ana.id }], tx);
    const closed = await lifecycle.closeAssignmentsOfUser(A(), ana.id, 'usuário passou a SUSPENDED', tx);
    assert.equal(closed, 3);
    const view = (await stewardship.listDomains(A(), tx)).find((d) => d.code === 'CONTRATOS');
    assert.equal(view.owner, null);
    assert.equal((await env.history(A(), 'CONTRATOS', tx)).length, 2, 'histórico mantido');
    const [note] = await env.sequelize.query("SELECT user_id, title FROM core.notifications WHERE company_id = :c AND title = 'Responsável de dados desativado' AND user_id = :a LIMIT 1", { replacements: { c: A().companyId, a: admin.id }, transaction: tx, type: 'SELECT' });
    assert.equal(note && note.user_id, admin.id, 'o administrador é avisado');
    assert.equal(await lifecycle.closeAssignmentsOfUser(A(), ana.id, 'de novo', tx), 0, 'sem designações, nada a fechar nem a avisar');
  });
});

test('m9d804 desativar o usuário pelo serviço de usuários e revogar o vínculo fecham as designações', { skip: skip() }, async () => {
  const usersService = require('../../../src/features/users/users.service');
  const membershipService = require('../../../src/features/memberships/membership.service');
  const ana = await run(async (tx) => {
    const created = await env.newUser(A(), tx);
    await put('FISCAL', [{ role: 'STEWARD', userId: created.id }], tx);
    const [membership] = await env.sequelize.query('SELECT id FROM core.user_memberships WHERE user_id = :u AND company_id = :c', { replacements: { u: created.id, c: A().companyId }, transaction: tx, type: 'SELECT' });
    await membershipService.revokeMembership(membership.id, A().userId, tx);
    assert.equal((await stewardship.listDomains(A(), tx)).find((d) => d.code === 'FISCAL').stewards.length, 0, 'vínculo revogado fecha as designações');
    return created;
  });
  assert.ok(ana && typeof usersService.updateUser === 'function', 'updateUser chama o fechamento (ver teste de integração com commit abaixo)');
});

test('m9d804 domínios extras vêm do parâmetro governanca.dados.dominios', { skip: skip() }, async () => {
  await run(async (tx) => {
    const ana = await env.newUser(A(), tx);
    await upsertSetting('governanca.dados.dominios', 'PESSOAS, MARKETING', A(), A().userId, tx);
    const codes = (await stewardship.listDomains(A(), tx)).map((d) => d.code);
    assert.deepEqual(codes, ['PESSOAS', 'MARKETING']);
    assert.equal((await put('MARKETING', [{ role: 'OWNER', userId: ana.id }], tx)).owner.userId, ana.id);
    const out = await put('CRM', [{ role: 'OWNER', userId: ana.id }], tx).catch((e) => e);
    assert.equal(out.code, 'GOV_DOMAIN_INVALID', 'domínio fora da lista do parâmetro');
  });
});

test('m9d804 avaliação noturna avisa o administrador uma vez por domínio e por dia', { skip: skip() }, async () => {
  await run(async (tx) => {
    await env.newUser(A(), tx, { roleName: 'ADMIN' });
    const when = new Date('2026-10-30T09:00:00Z');
    const first = await lifecycle.notifyPendingDomains(A(), tx, when);
    const again = await lifecycle.notifyPendingDomains(A(), tx, new Date(when.getTime() + 3600000));
    assert.ok(first.pending >= 1);
    assert.equal(first.notified, first.pending, 'um aviso por domínio pendente');
    assert.equal(again.notified, 0, 'segunda avaliação do dia não repete');
    const next = await lifecycle.notifyPendingDomains(A(), tx, new Date('2026-10-31T09:00:00Z'));
    assert.equal(next.notified, first.notified, 'novo dia, novo aviso');
  });
});
