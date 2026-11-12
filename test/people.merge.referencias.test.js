'use strict';

// M3-04 (DI-M3PE-5): o merge de pessoas remapeia TODA referência à pessoa. Guarda de catálogo (falha se o banco ganhar uma FK para
// people.persons, ou uma coluna *person*_id sem FK, que não esteja revisada em personMerge.catalog.js) e prova executável com as
// referências que a verificação de 11/11/2026 achou esquecidas (crm.feedback_cases.person_id, crm.proposals.proposed_by_person_id) e outras.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { randomCpf } = require('./helpers/pessoasVinculo');
const peopleService = require('../src/features/people/people.service');
const { mergePersons } = require('../src/features/people/personMerge.service');
// Módulos novos carregados dentro dos testes que os usam: na base, a prova executável do merge falha pela regra (referência não remapeada).
const refs = () => require('../src/features/people/personMerge.references');
const catalogo = () => require('../src/features/people/personMerge.catalog');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const q = (t, sql, replacements = {}) => sequelize.query(sql, { replacements, transaction: t, type: sequelize.QueryTypes.SELECT });
const pessoa = (t, nome, extra = {}) => peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `${nome} ${uniqueSuffix()}`, ...extra }, tenant.userId, t);

test('M3-04 guarda de catálogo: toda FK para people.persons(id) está revisada no merge, e a lista não tem coluna que não existe', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { REFERENCIAS_REVISADAS } = catalogo();
    const noBanco = (await refs().personForeignKeys(t)).map((r) => `${r.table}.${r.column}`);
    assert.ok(noBanco.length >= 39, `o catálogo devolveu só ${noBanco.length} FKs`);
    const semRevisao = noBanco.filter((k) => !REFERENCIAS_REVISADAS[k]);
    assert.deepEqual(semRevisao, [], `FK nova para pessoa sem política no merge (personMerge.catalog.js): ${semRevisao.join(', ')}`);
    const sobrando = Object.keys(REFERENCIAS_REVISADAS).filter((k) => !noBanco.includes(k));
    assert.deepEqual(sobrando, [], `política para FK que não existe mais no banco: ${sobrando.join(', ')}`);
    for (const [k, p] of Object.entries(REFERENCIAS_REVISADAS)) {
      assert.ok(['REMAPEAR', 'ESPECIAL', 'FORA'].includes(p.politica), k);
      if (p.politica === 'FORA') assert.ok(p.motivo && p.motivo.length > 20, `FORA sem motivo: ${k}`);
    }
  });
});

test('M3-04 guarda de catálogo: toda coluna uuid/jsonb com "person" no nome e sem FK está na lista sem FK ou fora, com motivo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const rows = await q(t, `SELECT c.table_schema || '.' || c.table_name || '.' || c.column_name AS k
        FROM information_schema.columns c JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
       WHERE c.column_name ILIKE '%person%' AND c.data_type IN ('uuid', 'jsonb') AND c.table_schema NOT IN ('pg_catalog', 'information_schema')`);
    const { REFERENCIAS_SEM_FK, COLUNAS_SEM_FK_FORA } = catalogo();
    const comFk = new Set((await refs().personForeignKeys(t)).map((r) => `${r.table}.${r.column}`));
    const semFk = new Set(REFERENCIAS_SEM_FK.map(([tb, col]) => `${tb}.${col}`));
    const faltando = rows.map((r) => r.k).filter((k) => !comFk.has(k) && !semFk.has(k) && !COLUNAS_SEM_FK_FORA[k]);
    assert.deepEqual(faltando, [], `coluna de pessoa sem FK e sem decisão no merge: ${faltando.join(', ')}`);
    for (const k of semFk) assert.ok(rows.some((r) => r.k === k), `lista sem FK cita coluna que não existe: ${k}`);
  });
});

test('M3-04 merge remapeia feedback_cases, proposals, conversas, garantias e o resto do mapa; nada fica na absorvida', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const canonica = await pessoa(t, 'Canônica Merge', { taxIdNormalized: randomCpf() });
    const absorvida = await pessoa(t, 'Absorvida Merge');
    const ctx = { g: tenant.groupId, c: tenant.companyId, a: absorvida.id, u: tenant.userId };
    const [caso] = await q(t, `INSERT INTO crm.feedback_cases (id, group_id, company_id, person_id, type, description, sla_due_at, created_by, updated_by, created_at, updated_at)
      VALUES (gen_random_uuid(), :g, :c, :a, 'COMPLAINT', 'Reclamação da absorvida', now() + interval '2 days', :u, :u, now(), now()) RETURNING id`, ctx).catch((e) => { throw new Error(`fixture feedback_cases: ${e.message}`); });
    const [opp] = await q(t, `INSERT INTO crm.opportunities (id, group_id, company_id, person_id, created_by, updated_by, created_at, updated_at)
      VALUES (gen_random_uuid(), :g, :c, :a, :u, :u, now(), now()) RETURNING id`, ctx).catch((e) => { throw new Error(`fixture opportunities: ${e.message}`); });
    const [prop] = await q(t, `INSERT INTO crm.proposals (id, group_id, company_id, opportunity_id, proposed_by_person_id, value, created_by, updated_by, created_at, updated_at)
      VALUES (gen_random_uuid(), :g, :c, :o, :a, 100000, :u, :u, now(), now()) RETURNING id`, { ...ctx, o: opp.id }).catch((e) => { throw new Error(`fixture proposals: ${e.message}`); });
    const [conv] = await q(t, `INSERT INTO crm.conversations (id, group_id, company_id, person_id, channel, created_at, updated_at)
      VALUES (gen_random_uuid(), :g, :c, :a, 'WHATSAPP', now(), now()) RETURNING id`, ctx).catch((e) => { throw new Error(`fixture conversations: ${e.message}`); });

    const result = await mergePersons(canonica.id, absorvida.id, tenant.userId, t);
    assert.equal(result.status, 'MERGED');
    for (const k of ['crm.feedback_cases.person_id', 'crm.proposals.proposed_by_person_id', 'crm.conversations.person_id', 'crm.opportunities.person_id']) {
      assert.equal(result.remappedReferences[k], 1, `${k} no mapa: ${JSON.stringify(result.remappedReferences)}`);
    }
    assert.equal((await q(t, 'SELECT person_id FROM crm.feedback_cases WHERE id = :id', { id: caso.id }))[0].person_id, canonica.id);
    assert.equal((await q(t, 'SELECT proposed_by_person_id FROM crm.proposals WHERE id = :id', { id: prop.id }))[0].proposed_by_person_id, canonica.id);
    assert.equal((await q(t, 'SELECT person_id FROM crm.conversations WHERE id = :id', { id: conv.id }))[0].person_id, canonica.id);

    // Nenhuma coluna REMAPEAR/ESPECIAL (nem sem FK) aponta mais para a absorvida.
    const { REFERENCIAS_REVISADAS, REFERENCIAS_SEM_FK } = catalogo();
    const alvos = [...Object.entries(REFERENCIAS_REVISADAS).filter(([, p]) => p.politica !== 'FORA').map(([k]) => k), ...REFERENCIAS_SEM_FK.map(([tb, c]) => `${tb}.${c}`)];
    for (const k of alvos) {
      const parts = k.split('.');
      const [{ n }] = await q(t, `SELECT count(*)::int AS n FROM "${parts[0]}"."${parts[1]}" WHERE "${parts[2]}" = :a`, { a: absorvida.id });
      assert.equal(n, 0, `${k} ainda aponta para a absorvida`);
    }
    const [audit] = await q(t, "SELECT after_json FROM audit.audit_log WHERE action = 'person.merge' AND entity_id = :id ORDER BY occurred_at DESC LIMIT 1", { id: canonica.id });
    assert.equal(audit.after_json.remappedReferences['crm.feedback_cases.person_id'], 1);
    assert.equal(audit.after_json.naoRevisadas, undefined, 'merge achou FK não revisada');
  });
});

test('M3-04 fiador adicional (lista JSON da garantia) segue a canônica sem repetir', async () => {
  const { Contract, Guarantee } = require('../src/models');
  await withRollbackTenantTransaction(tenant, async (t) => {
    const canonica = await pessoa(t, 'Canônica Fiador');
    const absorvida = await pessoa(t, 'Absorvida Fiador');
    const outro = await pessoa(t, 'Outro Fiador');
    const base = { groupId: tenant.groupId, companyId: tenant.companyId, createdBy: tenant.userId, updatedBy: tenant.userId };
    // Contrato em rascunho (o merge recusa contrato ATIVO em comum, não é o caso aqui) com garantia de fiador.
    const contrato = await Contract.create({ ...base, contractType: 'LEASE', contractNumber: `M3PE-${uniqueSuffix()}`, status: 'DRAFT' }, { transaction: t });
    const g = await Guarantee.create({ groupId: tenant.groupId, companyId: tenant.companyId, contractId: contrato.id, guaranteeType: 'GUARANTOR', status: 'PENDING', value: 1 }, { transaction: t });
    await q(t, 'UPDATE legal.guarantees SET additional_guarantor_person_ids = CAST(:l AS jsonb) WHERE id = :id', { id: g.id, l: JSON.stringify([absorvida.id, outro.id, canonica.id]) });
    const r = await mergePersons(canonica.id, absorvida.id, tenant.userId, t);
    assert.equal(r.remappedReferences['legal.guarantees.additional_guarantor_person_ids'], 1, JSON.stringify(r.remappedReferences));
    const [linha] = await q(t, 'SELECT additional_guarantor_person_ids AS l FROM legal.guarantees WHERE id = :id', { id: g.id });
    assert.deepEqual([...linha.l].sort(), [canonica.id, outro.id].sort());
  });
});

test('M3-04 tentativa bloqueada (CPF/CNPJ diferentes) fica marcada para a auditoria que sobrevive ao rollback', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const a = await pessoa(t, 'Bloqueio A', { taxIdNormalized: randomCpf() });
    const b = await pessoa(t, 'Bloqueio B', { taxIdNormalized: randomCpf() });
    await assert.rejects(() => mergePersons(a.id, b.id, tenant.userId, t), (err) => err.code === 'PERSON_MERGE_CONFLICT');
    const entry = (t.afterRollbackAudits || []).find((e) => e.action === 'person.merge.blocked');
    assert.ok(entry, 'person.merge.blocked não foi marcada');
    assert.equal(entry.companyId, tenant.companyId);
    assert.equal(entry.afterJson.codigo, 'PERSON_MERGE_CONFLICT');
    assert.equal(entry.afterJson.absorbedId, b.id);
  });
});

test('M3-04 tabela que o papel da aplicação não pode alterar: sem linha da absorvida o merge segue; com linha, recusa clara (nada órfão)', async (t) => {
  if (process.env.DISPOSABLE_DB !== '1' || !process.env.DATABASE_ADMIN_URL) return t.skip('mexe em GRANT: só em banco descartável');
  const { adminQuery } = require('./m9d801.helpers');
  const papel = (await sequelize.query('SELECT current_user AS u', { plain: true })).u;
  await adminQuery(`REVOKE UPDATE ON crm.conversations FROM "${papel}"`);
  try {
    await withRollbackTenantTransaction(tenant, async (tx) => {
      const canonica = await pessoa(tx, 'Canônica Protegida');
      const livre = await pessoa(tx, 'Absorvida Sem Conversa');
      assert.equal((await mergePersons(canonica.id, livre.id, tenant.userId, tx)).status, 'MERGED');
      const presa = await pessoa(tx, 'Absorvida Com Conversa');
      await q(tx, `INSERT INTO crm.conversations (group_id, company_id, person_id, channel) VALUES (:g, :c, :a, 'EMAIL') RETURNING id`, { g: tenant.groupId, c: tenant.companyId, a: presa.id });
      await assert.rejects(() => mergePersons(canonica.id, presa.id, tenant.userId, tx), (err) => {
        assert.equal(err.code, 'PERSON_MERGE_PROTECTED_REFERENCE');
        assert.equal(err.details.referencia, 'crm.conversations.person_id');
        return true;
      });
    });
  } finally {
    await adminQuery(`GRANT UPDATE ON crm.conversations TO "${papel}"`);
  }
});
