'use strict';

// ISO-8 (verificação independente do isolamento do Marco 9, 11/11/2026; DI-M9R-1): no contexto da empresa B do MESMO grupo,
// com o papel de runtime sem BYPASSRLS, o banco aceitava INSERT em person_contacts, person_addresses, person_documents,
// person_roles e communication_consents com company_id = B e person_id = pessoa da empresa A (a FK era só person_id e a
// checagem de FK não passa pelo RLS). Livro: A.4 "Chaves estrangeiras multiempresa usarão company_id na chave para impedir
// vínculos cruzados"; §7 "Chaves estrangeiras devem impedir vínculos entre empresas incompatíveis".
// Correção: migration 20260101009966 (FK composta (person_id, company_id) -> persons (id, company_id)).
// Cada linha é copiada de uma linha VÁLIDA da própria empresa B (mesmas colunas), trocando só o person_id: o único motivo de
// recusa possível é a pessoa ser de outra empresa. Tudo numa transação com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { Company } = require('../src/models');
const peopleService = require('../src/features/people/people.service');
const consents = require('../src/features/people/personConsents.service');
const contacts = require('../src/features/people/personContacts.service');
const addresses = require('../src/features/people/personAddresses.service');
const roles = require('../src/features/people/personRoles.service');

const FILHOS = ['person_contacts', 'person_addresses', 'person_documents', 'person_roles', 'communication_consents'];
let tenant;

before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const q = (transaction, sql, replacements = {}) => sequelize.query(sql, { replacements, transaction });
const usarEmpresa = (transaction, companyId) => q(transaction, "SELECT set_config('app.company_id', :c, true)", { c: companyId });

async function tentar(transaction, fn) {
  await q(transaction, 'SAVEPOINT iso8');
  try {
    const valor = await fn();
    await q(transaction, 'RELEASE SAVEPOINT iso8');
    return { erro: null, valor };
  } catch (erro) {
    await q(transaction, 'ROLLBACK TO SAVEPOINT iso8');
    return { erro, valor: null };
  }
}

const criarPessoa = (transaction, companyId, nome) => peopleService.createPerson(
  { groupId: tenant.groupId, companyId, personType: 'PF', legalName: nome, allowDuplicate: true }, tenant.userId, transaction
);

/** Pessoa da empresa (do contexto) com um filho de cada tipo; devolve o id da linha de cada tabela. */
async function pessoaComFilhos(transaction, companyId, suf) {
  const pessoa = await criarPessoa(transaction, companyId, `Pessoa ISO-8 ${suf}`);
  await contacts.createContact(pessoa.id, { contactType: 'EMAIL', valueNormalized: `iso8-${suf}@exemplo.test`, isPrimary: true }, tenant.userId, transaction);
  await addresses.createAddress(pessoa.id, { street: 'Rua ISO-8', number: '8', zipCode: '01310100', city: 'São Paulo', state: 'SP' }, tenant.userId, transaction);
  await roles.createRole(pessoa.id, { roleCode: roles.VALID_ROLES[0] }, tenant.userId, transaction);
  await consents.recordConsent(pessoa.id, { channel: 'EMAIL', purpose: 'MARKETING', status: 'OPT_IN' }, tenant.userId, transaction);
  const [[arquivo]] = await q(transaction, `INSERT INTO people.files (id, group_id, company_id, storage_key, file_name, created_at, updated_at)
    VALUES (gen_random_uuid(), :g, :c, :k, 'iso8.pdf', now(), now()) RETURNING id`, { g: tenant.groupId, c: companyId, k: `iso8/${suf}` });
  await q(transaction, `INSERT INTO people.person_documents (id, group_id, company_id, person_id, document_type, file_id, created_at, updated_at)
    VALUES (gen_random_uuid(), :g, :c, :p, 'RG', :f, now(), now())`, { g: tenant.groupId, c: companyId, p: pessoa.id, f: arquivo.id });
  const ids = {};
  for (const t of FILHOS) {
    const [[linha]] = await q(transaction, `SELECT id FROM people.${t} WHERE person_id = :p LIMIT 1`, { p: pessoa.id });
    assert.ok(linha, `faltou a linha de ${t} da própria empresa`);
    ids[t] = linha.id;
  }
  return { pessoa, ids };
}

async function colunas(transaction, tabela) {
  const [linhas] = await q(transaction, `SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'people' AND table_name = :t AND is_generated = 'NEVER' ORDER BY ordinal_position`, { t: tabela });
  return linhas.map((l) => l.column_name);
}

/** Copia a linha `origemId` da tabela trocando o id (novo) e o person_id; company_id e o resto ficam iguais. */
async function copiarComPessoa(transaction, tabela, origemId, personId) {
  const cols = await colunas(transaction, tabela);
  const sel = cols.map((c) => (c === 'id' ? 'gen_random_uuid()' : c === 'person_id' ? ':personId' : `"${c}"`));
  return q(transaction, `INSERT INTO people.${tabela} (${cols.map((c) => `"${c}"`).join(', ')})
    SELECT ${sel.join(', ')} FROM people.${tabela} WHERE id = :origemId RETURNING id, company_id, person_id`, { origemId, personId });
}

test('o papel de runtime dos testes não ignora o RLS (sem BYPASSRLS, sem superusuário)', async () => {
  const [[papel]] = await sequelize.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual([papel.rolsuper, papel.rolbypassrls], [false, false]);
});

test('ISO-8: no contexto da empresa B do mesmo grupo, nenhum filho de B aceita person_id de pessoa da empresa A', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suf = uniqueSuffix();
    const empresaB = await Company.create({ groupId: tenant.groupId, name: `ISO-8 B ${suf}`, status: 'ACTIVE' }, { transaction });
    const pessoaA = await criarPessoa(transaction, tenant.companyId, `Pessoa A ISO-8 ${suf}`);

    await usarEmpresa(transaction, empresaB.id);
    const { ids } = await pessoaComFilhos(transaction, empresaB.id, `b-${suf}`);
    const outraDeB = await criarPessoa(transaction, empresaB.id, `Outra pessoa de B ${suf}`);

    const resultado = {};
    for (const t of FILHOS) {
      // controle: a mesma cópia para outra pessoa de B é aceita (a linha é válida)
      const ok = await tentar(transaction, () => copiarComPessoa(transaction, t, ids[t], outraDeB.id));
      assert.equal(ok.erro, null, `${t}: a cópia para outra pessoa de B devia passar: ${ok.erro && ok.erro.message}`);

      const r = await tentar(transaction, () => copiarComPessoa(transaction, t, ids[t], pessoaA.id));
      const pg = r.erro && (r.erro.parent || r.erro.original || r.erro);
      resultado[t] = r.erro ? `${pg.code} ${pg.constraint || pg.message}` : 'ACEITO';
    }
    const esperado = Object.fromEntries(FILHOS.map((t) => [t, `23503 ${t}_person_same_company_fkey`]));
    assert.deepEqual(resultado, esperado, `com company_id = B e person_id da empresa A (ACEITO = vínculo cruzado gravado): ${JSON.stringify(resultado)}`);

    // a empresa A continua sem nenhum filho de B na pessoa dela
    await usarEmpresa(transaction, tenant.companyId);
    for (const t of FILHOS) {
      const [[{ n }]] = await q(transaction, `SELECT count(*)::int AS n FROM people.${t} WHERE person_id = :p`, { p: pessoaA.id });
      assert.equal(n, 0, `${t}: apareceu filho na pessoa de A`);
    }
  });
});

test('ISO-8: as cinco chaves compostas existem, validadas, apontando para persons (id, company_id)', async () => {
  const [linhas] = await sequelize.query(`SELECT con.conname, con.convalidated, c.relname AS tabela,
      (SELECT array_agg(a.attname::text ORDER BY k.i) FROM unnest(con.conkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n) AS cols,
      (SELECT array_agg(a.attname::text ORDER BY k.i) FROM unnest(con.confkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n) AS ref
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.contype = 'f' AND n.nspname = 'people' AND con.confrelid = 'people.persons'::regclass AND array_length(con.conkey, 1) = 2`);
  const porTabela = Object.fromEntries(linhas.map((l) => [l.tabela, l]));
  for (const t of FILHOS) {
    const l = porTabela[t];
    assert.ok(l, `${t}: sem FK composta para people.persons`);
    assert.equal(l.conname, `${t}_person_same_company_fkey`);
    assert.equal(l.convalidated, true);
    assert.deepEqual(l.cols, ['person_id', 'company_id']);
    assert.deepEqual(l.ref, ['id', 'company_id']);
  }
});
