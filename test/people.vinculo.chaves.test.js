'use strict';

// Guarda de catálogo do A.4 e do §7 para Pessoas (ISO-8, DI-M9I-7): toda chave estrangeira para people.persons numa tabela com
// company_id tem a companheira composta (pessoa, company_id) -> people.person_company_links, validada. Assim nenhuma linha de
// uma empresa aponta para pessoa que não está vinculada a ela, mesmo em SQL direto. As exceções ficam listadas uma a uma:
// a própria persons (merged_into_id, mesclagem dentro da empresa responsável) e as FKs dos schemas marketing e construction,
// que estão com outras esteiras em paralelo e recebem a mesma migration (20260101010944, lista FORA) quando a coordenação liberar.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('./testHelpers');

after(async () => { await sequelize.close(); });

const EXCECOES = [
  'people.persons.merged_into_id',
  'construction.daily_workers.person_id',
  'construction.maintenance_cases.opened_by_person_id',
  'marketing.attribution_events.person_id',
  'marketing.campaign_audience_members.person_id',
  'marketing.campaign_step_deliveries.person_id',
  'marketing.reminder_pendings.person_id',
  'marketing.review_requests.person_id',
  'marketing.suppression_list.person_id',
];

test('A.4: toda FK para people.persons em tabela com company_id tem a companheira (pessoa, company_id) para o vínculo, validada', async () => {
  const [simples] = await sequelize.query(`SELECT n.nspname || '.' || c.relname || '.' || a.attname AS ref, n.nspname || '.' || c.relname AS tabela, a.attname AS coluna
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
     WHERE con.contype = 'f' AND con.confrelid = 'people.persons'::regclass AND array_length(con.conkey, 1) = 1
       AND EXISTS (SELECT 1 FROM information_schema.columns x WHERE x.table_schema = n.nspname AND x.table_name = c.relname AND x.column_name = 'company_id')
     ORDER BY 1`);
  assert.ok(simples.length >= 30, `catálogo pequeno demais (${simples.length})`);
  const [compostas] = await sequelize.query(`SELECT con.conrelid::regclass::text AS tabela, a.attname AS coluna, con.convalidated, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
     WHERE con.contype = 'f' AND con.confrelid = 'people.person_company_links'::regclass`);
  const temComposta = (s) => compostas.some((k) => k.tabela === s.tabela && k.coluna === s.coluna
    && k.convalidated && new RegExp(`^FOREIGN KEY \\(${s.coluna}, company_id\\) REFERENCES people\\.person_company_links\\(person_id, company_id\\)`).test(k.def));
  const faltando = simples.filter((s) => !EXCECOES.includes(s.ref) && !temComposta(s)).map((s) => s.ref);
  assert.deepEqual(faltando, [], 'FK para pessoa sem a chave composta do vínculo: a empresa poderia apontar para pessoa de outra empresa');
  const excecoesQueNaoExistem = EXCECOES.filter((e) => !simples.some((s) => s.ref === e));
  assert.deepEqual(excecoesQueNaoExistem, [], 'exceção listada que não existe mais no catálogo: retire da lista');
});

test('A.4 em SQL direto, sem RLS (superusuário): oportunidade e conta bancária da empresa B não apontam para pessoa de A sem vínculo; com o vínculo, apontam', async (t) => {
  if (process.env.DISPOSABLE_DB !== '1' || !process.env.DATABASE_ADMIN_URL) return t.skip('só no banco descartável (superusuário)');
  const { Sequelize } = require('sequelize');
  const { getSeedTenant } = require('./testHelpers');
  const tenant = await getSeedTenant();
  const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
  const tx = await admin.transaction();
  try {
    const q = async (sql, replacements) => (await admin.query(sql, { replacements, transaction: tx }))[0];
    const tentar = async (sql, replacements) => { await q('SAVEPOINT a4'); try { await q(sql, replacements); await q('RELEASE SAVEPOINT a4'); return null; } catch (e) { await q('ROLLBACK TO SAVEPOINT a4'); return e; } };
    const [b] = await q("INSERT INTO core.companies (id, group_id, name, status, created_at, updated_at) VALUES (gen_random_uuid(), :g, 'A4 B', 'ACTIVE', now(), now()) RETURNING id", { g: tenant.groupId });
    const [p] = await q("INSERT INTO people.persons (id, group_id, company_id, person_type, legal_name, status) VALUES (gen_random_uuid(), :g, :a, 'PF', 'A4 P', 'ACTIVE') RETURNING id", { g: tenant.groupId, a: tenant.companyId });
    const rep = { g: tenant.groupId, b: b.id, p: p.id };
    const oportunidade = "INSERT INTO crm.opportunities (id, group_id, company_id, person_id, created_at, updated_at) VALUES (gen_random_uuid(), :g, :b, :p, now(), now())";
    const conta = "INSERT INTO finance.bank_accounts (id, group_id, company_id, owner_person_id, created_at, updated_at) VALUES (gen_random_uuid(), :g, :b, :p, now(), now())";
    for (const sql of [oportunidade, conta]) {
      const erro = await tentar(sql, rep);
      assert.equal(erro && erro.parent.code, '23503', `${sql.slice(12, 40)}: ${erro && erro.parent.message}`);
      assert.match(erro.parent.constraint, /_vinc_fkey$/);
    }
    await q("INSERT INTO people.person_company_links (group_id, company_id, person_id, origin, status) VALUES (:g, :b, :p, 'LINKED', 'ACTIVE')", rep);
    assert.equal(await tentar(oportunidade, rep), null, 'com o vínculo, a oportunidade de B para a pessoa vinculada entra');
  } finally {
    await tx.rollback();
    await admin.close();
  }
});
