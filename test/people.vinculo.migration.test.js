'use strict';

// As migrations do vínculo (20260101010940 e 20260101010941) sobre DADOS QUE JÁ EXISTEM: toda pessoa ganha o vínculo da empresa
// que a criou (nada muda para quem já usa), a linha filha que apontava para pessoa de outra empresa do grupo é preservada com
// vínculo ENCERRADO e auditoria (a empresa continua sem ver a pessoa), linha que aponta para pessoa de OUTRO grupo para a
// migration sem alterar nada, e o down volta exatamente ao estado anterior. Precisa de superusuário: só no banco descartável.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Sequelize } = require('sequelize');

const { sequelize, getSeedTenant } = require('./testHelpers');
const { TENANTS } = require('../scripts/seed-ci-two-tenants');

const M940 = require(path.resolve(__dirname, '../migrations/20260101010940-pessoas-vinculo-por-empresa.js'));
const M941 = require(path.resolve(__dirname, '../migrations/20260101010941-pessoas-filhos-so-com-pessoa-vinculada.js'));
const M944 = require(path.resolve(__dirname, '../migrations/20260101010944-pessoas-chave-composta-nos-outros-modulos.js'));

after(async () => { await sequelize.close(); });

test('migrations do vínculo: dados existentes, linha cruzada preservada com auditoria, outro grupo para tudo, down e up de novo', async (t) => {
  if (process.env.DISPOSABLE_DB !== '1' || !process.env.DATABASE_ADMIN_URL) return t.skip('só roda no banco descartável (DISPOSABLE_DB=1 e DATABASE_ADMIN_URL)');
  const tenant = await getSeedTenant();
  const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
  const qi = admin.getQueryInterface();
  const aq = async (sql, replacements) => (await admin.query(sql, { replacements }))[0];
  const politicaSelect = async () => (await aq("SELECT qual FROM pg_policies WHERE schemaname = 'people' AND tablename = 'persons' AND policyname = 'persons_company_select'"))[0].qual;
  try {
    const depois = await politicaSelect();
    await M944.down(qi);
    await M941.down(qi);
    await M940.down(qi);
    // Banco ANTERIOR à 9966 do Marco 9 (é onde podia existir linha cruzada): o down da 0941 devolve a chave "filho só da empresa da
    // pessoa" da 9966; aqui ela sai para o cenário de dados antigos (a 0941 a remove de novo no up, como em qualquer banco com a 9966).
    for (const t of ['person_contacts', 'person_addresses', 'person_documents', 'person_roles', 'communication_consents']) {
      await aq(`ALTER TABLE people.${t} DROP CONSTRAINT IF EXISTS ${t}_person_same_company_fkey`);
    }
    const antes = await politicaSelect();
    assert.ok(!/person_company_links/.test(antes), 'o down volta à leitura só por empresa');
    assert.equal((await aq("SELECT to_regclass('people.person_company_links') AS r"))[0].r, null, 'o down remove a tabela de vínculo');

    // Dados de antes: A com pessoa ativa e pessoa excluída; B (mesmo grupo) com um contato apontando para a pessoa de A.
    const [b] = await aq("INSERT INTO core.companies (id, group_id, name, status, created_at, updated_at) VALUES (gen_random_uuid(), :g, 'Migração B', 'ACTIVE', now(), now()) RETURNING id", { g: tenant.groupId });
    const [p1] = await aq("INSERT INTO people.persons (id, group_id, company_id, person_type, legal_name, status, created_by) VALUES (gen_random_uuid(), :g, :a, 'PF', 'Antiga Ativa', 'ACTIVE', :u) RETURNING id", { g: tenant.groupId, a: tenant.companyId, u: tenant.userId });
    const [p2] = await aq("INSERT INTO people.persons (id, group_id, company_id, person_type, legal_name, status, deleted_at) VALUES (gen_random_uuid(), :g, :a, 'PF', 'Antiga Excluída', 'ACTIVE', now()) RETURNING id", { g: tenant.groupId, a: tenant.companyId });
    await aq("INSERT INTO people.person_contacts (id, group_id, company_id, person_id, contact_type, value_normalized, is_primary, created_at, updated_at) VALUES (gen_random_uuid(), :g, :a, :p, 'EMAIL', 'antiga@a.test', true, now(), now())", { g: tenant.groupId, a: tenant.companyId, p: p1.id });
    const [p3] = await aq("INSERT INTO people.persons (id, group_id, company_id, person_type, legal_name, status) VALUES (gen_random_uuid(), :g, :a, 'PF', 'Antiga com oportunidade em B', 'ACTIVE') RETURNING id", { g: tenant.groupId, a: tenant.companyId });
    const [oport] = await aq("INSERT INTO crm.opportunities (id, group_id, company_id, person_id, created_at, updated_at) VALUES (gen_random_uuid(), :g, :b, :p, now(), now()) RETURNING id", { g: tenant.groupId, b: b.id, p: p3.id });
    const [cruzado] = await aq("INSERT INTO people.person_contacts (id, group_id, company_id, person_id, contact_type, value_normalized, is_primary, created_at, updated_at) VALUES (gen_random_uuid(), :g, :b, :p, 'EMAIL', 'cruzado@b.test', false, now(), now()) RETURNING id", { g: tenant.groupId, b: b.id, p: p1.id });

    // Linha de OUTRO grupo apontando para a pessoa de A: a 0941 para e nada muda.
    const [outroGrupo] = await aq('SELECT c.id, c.group_id FROM core.companies c JOIN core.groups g ON g.id = c.group_id WHERE g.name = :n LIMIT 1', { n: TENANTS[1].groupName });
    await M940.up(qi);
    const [estranho] = await aq("INSERT INTO people.person_roles (id, group_id, company_id, person_id, role_code, created_at, updated_at) VALUES (gen_random_uuid(), :g, :c, :p, 'FIADOR', now(), now()) RETURNING id", { g: outroGrupo.group_id, c: outroGrupo.id, p: p1.id });
    await assert.rejects(M941.up(qi), /OUTRO grupo\. Nada foi alterado/);
    assert.equal((await aq("SELECT count(*)::int AS n FROM people.person_company_links WHERE person_id = :p AND company_id = :b", { p: p1.id, b: b.id }))[0].n, 0, 'nada foi gravado na tentativa parada');
    await aq('DELETE FROM people.person_roles WHERE id = :id', { id: estranho.id });

    await M941.up(qi);
    await M944.up(qi);
    assert.equal(await politicaSelect(), depois, 'o up recria exatamente a política de leitura por vínculo');
    const links = await aq('SELECT person_id, company_id, origin, status, end_reason FROM people.person_company_links WHERE person_id IN (:ids) ORDER BY origin DESC', { ids: [p1.id, p2.id] });
    assert.deepEqual(links.filter((l) => l.origin === 'OWNER').map((l) => [l.person_id, l.company_id, l.status]).sort(),
      [[p1.id, tenant.companyId, 'ACTIVE'], [p2.id, tenant.companyId, 'ACTIVE']].sort(), 'toda pessoa existente (inclusive excluída) ganha o vínculo da empresa que a criou');
    const preservado = links.find((l) => l.origin === 'LINKED');
    assert.deepEqual([preservado.company_id, preservado.status], [b.id, 'ENDED'], 'a linha cruzada vira vínculo ENCERRADO de B');
    const [trilha] = await aq("SELECT action, reason FROM audit.audit_log WHERE entity_id = :p AND company_id = :b", { p: p1.id, b: b.id });
    assert.equal(trilha.action, 'people.person.link_preserved');
    assert.match(trilha.reason, /1 linha\(s\) de people\.person_contacts/);
    assert.equal((await aq('SELECT count(*)::int AS n FROM people.person_contacts WHERE id = :id', { id: cruzado.id }))[0].n, 1, 'o dado foi preservado');
    // Outro módulo (0944): a oportunidade de B para a pessoa de A também é preservada, com vínculo ENCERRADO e auditoria própria.
    const [linkOport] = await aq('SELECT origin, status FROM people.person_company_links WHERE person_id = :p AND company_id = :b', { p: p3.id, b: b.id });
    assert.deepEqual(linkOport, { origin: 'LINKED', status: 'ENDED' });
    const [trilhaOport] = await aq("SELECT reason FROM audit.audit_log WHERE entity_id = :p AND company_id = :b AND action = 'people.person.link_preserved'", { p: p3.id, b: b.id });
    assert.match(trilhaOport.reason, /1 linha\(s\) de crm\.opportunities\.person_id/);
    assert.equal((await aq('SELECT count(*)::int AS n FROM crm.opportunities WHERE id = :id', { id: oport.id }))[0].n, 1);

    // No runtime: A continua vendo tudo o que era dela; B não vê a pessoa (vínculo encerrado), mas o contato dela segue dela.
    const transaction = await sequelize.transaction();
    try {
      const q = (sql, replacements) => sequelize.query(sql, { replacements, transaction }).then(([r]) => r);
      await q("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :a, true)", { g: tenant.groupId, a: tenant.companyId });
      assert.equal((await q('SELECT count(*)::int AS n FROM people.persons WHERE id IN (:ids)', { ids: [p1.id, p2.id] }))[0].n, 2);
      assert.deepEqual((await q('SELECT value_normalized FROM people.person_contacts WHERE person_id = :p', { p: p1.id })).map((r) => r.value_normalized), ['antiga@a.test']);
      await q("SELECT set_config('app.company_id', :b, true)", { b: b.id });
      assert.equal((await q('SELECT count(*)::int AS n FROM people.persons WHERE id = :p', { p: p1.id }))[0].n, 0);
      assert.equal((await q('SELECT count(*)::int AS n FROM people.person_contacts WHERE person_id = :p', { p: p1.id }))[0].n, 1);
    } finally {
      await transaction.rollback();
    }

    const fks = await aq("SELECT count(*)::int AS n FROM pg_constraint WHERE conname LIKE '%_person_company_link_fkey' AND convalidated");
    assert.equal(fks[0].n, 5);
  } finally {
    // O banco descartável fica no estado das migrations, mesmo se uma asserção falhar no meio.
    const tem = (await aq("SELECT to_regclass('people.person_company_links') AS r"))[0].r;
    if (!tem) await M940.up(qi).catch(() => {});
    const fk = (await aq("SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'person_contacts_person_company_link_fkey'"))[0].n;
    if (!fk) await M941.up(qi).catch(() => {});
    const outras = (await aq("SELECT count(*)::int AS n FROM pg_constraint WHERE conname LIKE '%\\_vinc\\_fkey'"))[0].n;
    if (!outras) await M944.up(qi).catch(() => {});
    await admin.close();
  }
});
