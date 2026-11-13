'use strict';

// Pessoa do GRUPO vista por VÍNCULO com a empresa, provado no BANCO com o papel de runtime (sem BYPASSRLS), em SQL direto com
// set_config, sem passar pela API (ISO-4 e ISO-8 da verificação de 11/11/2026; DI-M9I-1 a DI-M9I-7; migrations
// 20260101010940 e 20260101010941). Livro: TAB-0100/0101, CRMX-015, §26 (company_scope_allows), §7 e A.4.
// Tudo numa transação com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const { FILHOS, q, usarEmpresa, prova, tentar, cenario, contarFilhos } = require('./helpers/pessoasVinculo');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const LINHA_FILHA = {
  person_contacts: "(id, group_id, company_id, person_id, contact_type, value_normalized, is_primary, created_at, updated_at) VALUES (gen_random_uuid(), :g, :c, :p, 'EMAIL', 'invasor@x.test', false, now(), now())",
  person_addresses: "(id, group_id, company_id, person_id, street, city, state, is_current, created_at, updated_at) VALUES (gen_random_uuid(), :g, :c, :p, 'Rua B', 'X', 'SP', false, now(), now())",
  person_documents: "(id, group_id, company_id, person_id, document_type, file_id, version_no, verification_status, created_at, updated_at) VALUES (gen_random_uuid(), :g, :c, :p, 'CNH', :f, 99, 'PENDING', now(), now())",
  person_roles: "(id, group_id, company_id, person_id, role_code, created_at, updated_at) VALUES (gen_random_uuid(), :g, :c, :p, 'FIADOR', now(), now())",
  communication_consents: "(id, group_id, company_id, person_id, channel, purpose, status, recorded_at, created_at, updated_at) VALUES (gen_random_uuid(), :g, :c, :p, 'PHONE', 'VINCULO', 'OPT_IN', now(), now(), now())",
};
const inserirFilho = (transaction, t, rep) => q(transaction, `INSERT INTO people.${t} ${LINHA_FILHA[t]}`, rep);

test('vínculo: o papel da sessão é o de runtime, sem superusuário nem BYPASSRLS (as provas abaixo valem para a aplicação)', async () => {
  const [[papel]] = await sequelize.query('SELECT r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user');
  assert.equal(papel.rolsuper, false);
  assert.equal(papel.rolbypassrls, false);
});

test('vínculo: B não vê a pessoa de A sem vínculo (por id, por CPF, na contagem) e a prova com nome errado não abre nada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { empresaB, pessoa, cpf } = await cenario(t, tenant);
    const [[dono]] = await q(t, "SELECT origin, status FROM people.person_company_links WHERE person_id = :p", { p: pessoa.id });
    assert.deepEqual(dono, { origin: 'OWNER', status: 'ACTIVE' }, 'o cadastro novo nasce com o vínculo da empresa responsável (gatilho)');

    await usarEmpresa(t, empresaB.id);
    const [porId] = await q(t, 'SELECT id FROM people.persons WHERE id = :p OR tax_id_normalized = :d', { p: pessoa.id, d: cpf });
    assert.equal(porId.length, 0, 'sem vínculo, B não enxerga a pessoa de A');
    const [[outras]] = await q(t, 'SELECT count(*)::int AS n FROM people.persons WHERE company_id <> :b', { b: empresaB.id });
    assert.equal(outras.n, 0);
    const [[links]] = await q(t, 'SELECT count(*)::int AS n FROM people.person_company_links');
    assert.equal(links.n, 0, 'B não enxerga vínculos de outras empresas');

    await prova(t, cpf, 'Fulano Qualquer');
    const [errado] = await q(t, 'SELECT id FROM people.persons WHERE tax_id_normalized = :d', { d: cpf });
    assert.equal(errado.length, 0, 'CPF certo com nome errado não mostra a pessoa');
    await prova(t, '', 'Maria Souza');
    const [semDoc] = await q(t, 'SELECT id FROM people.persons');
    assert.equal(semDoc.length, 0, 'nome sem o CPF não mostra nada');
  });
});

test('vínculo: B só cria o vínculo com a prova (CPF + nome) e passa a ver só a base; contatos, endereços, documentos, papéis e consentimentos de A continuam invisíveis', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { empresaB, pessoa, cpf } = await cenario(t, tenant);
    await usarEmpresa(t, empresaB.id);
    const rep = { g: tenant.groupId, c: empresaB.id, p: pessoa.id };
    const semProva = await tentar(t, () => q(t, "INSERT INTO people.person_company_links (group_id, company_id, person_id, origin) VALUES (:g, :c, :p, 'LINKED')", rep));
    assert.equal(semProva.erro && semProva.erro.parent.code, '42501', 'vínculo sem a prova é recusado pelo RLS');

    await prova(t, cpf, '  MARIA   souza ');
    const [vista] = await q(t, 'SELECT id FROM people.persons WHERE tax_id_normalized = :d', { d: cpf });
    assert.equal(vista.length, 1, 'com CPF e nome (primeiro e último, sem acento nem caixa) a pessoa aparece para vincular');
    const roubo = await tentar(t, () => q(t, "INSERT INTO people.person_company_links (group_id, company_id, person_id, origin) VALUES (:g, :c, :p, 'OWNER')", rep));
    assert.equal(roubo.erro && roubo.erro.parent.code, '42501', 'B não se declara responsável pela base de A');
    await q(t, "INSERT INTO people.person_company_links (group_id, company_id, person_id, origin) VALUES (:g, :c, :p, 'LINKED')", rep);
    await prova(t, '', '');

    const [base] = await q(t, 'SELECT id, legal_name FROM people.persons WHERE id = :p', { p: pessoa.id });
    assert.equal(base.length, 1, 'com o vínculo, B vê a base');
    const filhos = await contarFilhos(t, pessoa.id, empresaB.id);
    for (const tabela of FILHOS) assert.equal(filhos[tabela].total, 0, `${tabela}: B não vê nada de A`);
    const [[arquivos]] = await q(t, 'SELECT count(*)::int AS n FROM people.files WHERE company_id <> :b', { b: empresaB.id });
    assert.equal(arquivos.n, 0, 'nenhum arquivo de outra empresa');

    const [, upd] = await q(t, "UPDATE people.persons SET preferred_name = 'Invasor' WHERE id = :p", { p: pessoa.id });
    assert.equal(upd.rowCount, 0, 'a vinculada não altera a base');
    const [, del] = await q(t, 'DELETE FROM people.persons WHERE id = :p', { p: pessoa.id });
    assert.equal(del.rowCount, 0, 'a vinculada não apaga a base');

    await usarEmpresa(t, tenant.companyId);
    const deA = await contarFilhos(t, pessoa.id, tenant.companyId);
    for (const tabela of FILHOS) assert.equal(deA[tabela].total, deA[tabela].da_empresa, `${tabela}: A segue vendo só o que é dela`);
    for (const tabela of FILHOS) assert.ok(deA[tabela].da_empresa >= 1, `${tabela}: A continua vendo o próprio dado`);
    const [[linksDeA]] = await q(t, 'SELECT count(*)::int AS n FROM people.person_company_links WHERE person_id = :p', { p: pessoa.id });
    assert.equal(linksDeA.n, 1, 'A não enxerga o vínculo de B (só o próprio)');
  });
});

test('ISO-8: no contexto de B, sem vínculo, nenhum filho de B aponta para a pessoa de A (RLS) e, mesmo sem RLS, a chave composta recusa', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { empresaB, pessoa, fileId } = await cenario(t, tenant);
    await usarEmpresa(t, empresaB.id);
    const { arquivoDaEmpresa } = require('./helpers/pessoasVinculo');
    const fileB = await arquivoDaEmpresa(t, tenant, empresaB.id);
    for (const tabela of FILHOS) {
      const r = await tentar(t, () => inserirFilho(t, tabela, { g: tenant.groupId, c: empresaB.id, p: pessoa.id, f: fileB }));
      assert.ok(r.erro, `${tabela}: INSERT de B apontando para a pessoa de A tem de falhar`);
      assert.equal(r.erro.parent.code, '42501', `${tabela}: recusa do RLS (${r.erro.parent.message})`);
    }
    void fileId;
  });
  // Mesma linha pelo superusuário do cluster (ignora o RLS): sobra a chave estrangeira composta do livro (A.4).
  if (process.env.DISPOSABLE_DB !== '1' || !process.env.DATABASE_ADMIN_URL) return;
  const { Sequelize } = require('sequelize');
  const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
  const ta = await admin.transaction();
  try {
    const aq = (sql, replacements) => admin.query(sql, { replacements, transaction: ta });
    const [[b]] = await aq("INSERT INTO core.companies (id, group_id, name, status, created_at, updated_at) VALUES (gen_random_uuid(), :g, 'FK B', 'ACTIVE', now(), now()) RETURNING id", { g: tenant.groupId });
    const [[p]] = await aq("INSERT INTO people.persons (id, group_id, company_id, person_type, legal_name, status) VALUES (gen_random_uuid(), :g, :a, 'PF', 'FK P', 'ACTIVE') RETURNING id", { g: tenant.groupId, a: tenant.companyId });
    const [[f]] = await aq("INSERT INTO people.files (id, group_id, company_id, storage_key, file_name, created_at, updated_at) VALUES (gen_random_uuid(), :g, :b, 'fk/x', 'x.pdf', now(), now()) RETURNING id", { g: tenant.groupId, b: b.id });
    for (const tabela of FILHOS) {
      await aq('SAVEPOINT fk');
      const erro = await aq(`INSERT INTO people.${tabela} ${LINHA_FILHA[tabela]}`, { g: tenant.groupId, c: b.id, p: p.id, f: f.id }).then(() => null, (e) => e);
      await aq('ROLLBACK TO SAVEPOINT fk');
      assert.equal(erro && erro.parent.code, '23503', `${tabela}: a FK composta tem de recusar (${erro && erro.parent.message})`);
      assert.equal(erro.parent.constraint, `${tabela}_person_company_link_fkey`);
    }
  } finally {
    await ta.rollback();
    await admin.close();
  }
});

test('vínculo: B grava os próprios filhos da pessoa vinculada; desfazer é auditado, tira a visão e barra filho novo; reativar exige a prova de novo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { empresaB, pessoa, cpf, legalName } = await cenario(t, tenant);
    await usarEmpresa(t, empresaB.id);
    const rep = { g: tenant.groupId, c: empresaB.id, p: pessoa.id };
    await q(t, "SELECT set_config('app.vinculo_motivo', 'Cliente de A atendido em B', true)");
    await prova(t, cpf, legalName);
    await q(t, "INSERT INTO people.person_company_links (group_id, company_id, person_id, origin) VALUES (:g, :c, :p, 'LINKED')", rep);
    await prova(t, '', '');
    await q(t, "SELECT set_config('app.vinculo_motivo', '', true)");
    const { arquivoDaEmpresa } = require('./helpers/pessoasVinculo');
    const fileB = await arquivoDaEmpresa(t, tenant, empresaB.id);
    for (const tabela of FILHOS) await inserirFilho(t, tabela, { ...rep, f: fileB });
    const deB = await contarFilhos(t, pessoa.id, empresaB.id);
    for (const tabela of FILHOS) assert.deepEqual(deB[tabela], { total: 1, da_empresa: 1 }, `${tabela}: B vê só o próprio filho`);

    const [, fim] = await q(t, "UPDATE people.person_company_links SET status = 'ENDED', ended_at = now(), ended_by = :u, end_reason = 'Fim da relação' WHERE person_id = :p", { u: tenant.userId, p: pessoa.id });
    assert.equal(fim.rowCount, 1);
    const [semVisao] = await q(t, 'SELECT id FROM people.persons WHERE id = :p', { p: pessoa.id });
    assert.equal(semVisao.length, 0, 'vínculo desfeito: B deixa de ver a pessoa');
    const novo = await tentar(t, () => inserirFilho(t, 'person_contacts', rep));
    assert.equal(novo.erro && novo.erro.parent.code, '42501', 'vínculo desfeito não recebe filho novo');
    const volta = await tentar(t, () => q(t, "UPDATE people.person_company_links SET status = 'ACTIVE', ended_at = NULL WHERE person_id = :p", { p: pessoa.id }));
    assert.equal(volta.erro && volta.erro.parent.code, '42501', 'reativar sem a prova é recusado');
    // Vínculo não se apaga: sem política de DELETE (RLS deny-by-default) e, conforme o ambiente, também sem GRANT de DELETE.
    const apagar = await tentar(t, () => q(t, 'DELETE FROM people.person_company_links WHERE person_id = :p', { p: pessoa.id }));
    if (apagar.erro) assert.equal(apagar.erro.parent.code, '42501', 'vínculo não se apaga');
    else assert.equal(apagar.valor[1].rowCount, 0, 'vínculo não se apaga (sem política de DELETE)');
    await prova(t, cpf, legalName);
    await q(t, "UPDATE people.person_company_links SET status = 'ACTIVE', ended_at = NULL, ended_by = NULL, end_reason = NULL WHERE person_id = :p", { p: pessoa.id });
    await prova(t, '', '');

    const [trilha] = await q(t, "SELECT action, user_id, reason, after_json->>'status' AS status FROM audit.audit_log WHERE entity_id = :p AND action LIKE 'people.person.%link' ORDER BY occurred_at, created_at", { p: pessoa.id });
    assert.deepEqual(trilha.map((x) => x.action), ['people.person.link', 'people.person.unlink', 'people.person.relink']);
    assert.ok(trilha.every((x) => x.user_id === tenant.userId), 'a trilha leva o usuário da sessão');
    assert.equal(trilha[0].reason, 'Cliente de A atendido em B');
    await usarEmpresa(t, tenant.companyId);
    const [[trilhaEmA]] = await q(t, "SELECT count(*)::int AS n FROM audit.audit_log WHERE entity_id = :p AND action LIKE 'people.person.%link'", { p: pessoa.id });
    assert.equal(trilhaEmA.n, 0, 'a trilha do vínculo de B é de B');
  });
});

test('vínculo: a empresa responsável não exclui nem mescla a base enquanto outra empresa do grupo tem vínculo ativo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { empresaB, pessoa, cpf, legalName } = await cenario(t, tenant);
    await usarEmpresa(t, empresaB.id);
    await prova(t, cpf, legalName);
    await q(t, "INSERT INTO people.person_company_links (group_id, company_id, person_id, origin) VALUES (:g, :c, :p, 'LINKED')", { g: tenant.groupId, c: empresaB.id, p: pessoa.id });
    await prova(t, '', '');
    await usarEmpresa(t, tenant.companyId);
    for (const sql of ['UPDATE people.persons SET deleted_at = now() WHERE id = :p', "UPDATE people.persons SET status = 'MERGED' WHERE id = :p", 'DELETE FROM people.persons WHERE id = :p']) {
      const r = await tentar(t, () => q(t, sql, { p: pessoa.id }));
      assert.match(String(r.erro && r.erro.parent.message), /PERSON_LINKED_ELSEWHERE/, sql);
    }
  });
});
