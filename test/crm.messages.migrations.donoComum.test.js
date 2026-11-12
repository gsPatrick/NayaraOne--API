'use strict';

// Rodada 4 da verificação independente do Marco 9 (12/11/2026), lacuna de prova: as migrations 20260101009971 e 20260101009976 conferem os
// dados com o FORCE RLS desligado ("NO FORCE") porque, na homologação, quem roda as migrations é o DONO das tabelas sem BYPASSRLS. O ensaio
// anterior rodou como superusuário, que ignora o RLS de qualquer jeito, então o desvio nunca foi exercitado.
// Aqui as duas migrations rodam como um papel dono comum, criado no molde do papel de migração da homologação (LOGIN, sem SUPERUSER, sem
// BYPASSRLS, sem CREATEROLE, dono das tabelas que a migration altera), com o FORCE RLS ligado e sem contexto de empresa:
// - prova de que o papel é mesmo cego: um SELECT dele em crm.messages não vê nenhuma linha (o RLS vale para o dono com FORCE);
// - a conferência da 9971 enxerga as linhas de TODAS as empresas: a contagem bate com a do superusuário e a migration PARA com a linha cruzada;
//   corrigida a linha, cria as chaves compostas, validadas;
// - a conferência do down da 9976 enxerga o id externo usado por duas empresas e PARA; resolvido, volta o índice global; o up cria o por empresa;
// - no fim de cada passo o FORCE RLS das tabelas continua ligado.
// Tudo numa transação com rollback (o papel, a troca de dono e as linhas somem no fim). Só roda com DATABASE_ADMIN_URL (withDisposableDb.js).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Sequelize } = require('sequelize');
const m9971 = require('../migrations/20260101009971-mensagens-so-com-conversa-e-midia-da-mesma-empresa');
const m9976 = require('../migrations/20260101009976-mensagens-id-externo-unico-por-empresa');
const { TENANTS } = require('../scripts/seed-ci-two-tenants');

const ADMIN = process.env.DATABASE_ADMIN_URL;
const SEM_ADMIN = ADMIN ? false : 'Troca o dono das tabelas: só roda com DATABASE_ADMIN_URL (scripts/withDisposableDb.js).';
const sequelize = ADMIN ? new Sequelize(ADMIN, { logging: false }) : null;
const TABELAS = ['crm.messages', 'crm.conversations', 'files.quarantine'];

after(async () => { if (sequelize) await sequelize.close(); });

const qi = (externa) => ({ sequelize: { transaction: (cb) => sequelize.transaction({ transaction: externa }, cb), query: (sql, o) => sequelize.query(sql, o) } });
const q = (t, sql, replacements = {}) => sequelize.query(sql, { replacements, transaction: t });
const um = async (t, sql, r) => (await q(t, sql, r))[0][0];

/** Ids externos sem connection usados por mais de uma empresa, contados por fora da migration (superusuário): { ids, mensagens }. */
const compartilhados = async (t) => um(t, `WITH m AS (SELECT company_id, external_message_id FROM crm.messages WHERE external_message_id IS NOT NULL AND connection_id IS NULL),
  s AS (SELECT external_message_id FROM m GROUP BY 1 HAVING count(DISTINCT company_id) > 1)
  SELECT (SELECT count(*) FROM s)::int AS ids, (SELECT count(*) FROM m WHERE external_message_id IN (SELECT external_message_id FROM s))::int AS mensagens`);

/** "Quem decide" resolve todos os compartilhados (inclusive os que outros testes do mesmo banco gravaram): só a primeira empresa fica com o id. Some no rollback. */
const resolverCompartilhados = (t) => q(t, `UPDATE crm.messages m SET external_message_id = NULL WHERE m.connection_id IS NULL AND m.external_message_id IN (
    SELECT external_message_id FROM crm.messages WHERE external_message_id IS NOT NULL AND connection_id IS NULL GROUP BY 1 HAVING count(DISTINCT company_id) > 1)
  AND m.company_id <> (SELECT min(company_id::text)::uuid FROM crm.messages x WHERE x.external_message_id = m.external_message_id AND x.connection_id IS NULL)`);

/** Papel dono comum (sem SUPERUSER, sem BYPASSRLS), dono das três tabelas; tudo na transação. Devolve o nome. */
async function donoComum(t) {
  const papel = `ci_dono_${crypto.randomBytes(4).toString('hex')}`;
  await q(t, `CREATE ROLE ${papel} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`);
  await q(t, `GRANT USAGE, CREATE ON SCHEMA crm, files TO ${papel}`);
  for (const tabela of TABELAS) await q(t, `ALTER TABLE ${tabela} OWNER TO ${papel}`);
  return papel;
}

async function comoDono(t, papel, fn) {
  await q(t, `SET LOCAL ROLE ${papel}`);
  try { return await fn(); } finally { await q(t, 'RESET ROLE'); }
}

const forcados = async (t) => (await q(t, `SELECT n.nspname || '.' || c.relname AS tabela, c.relforcerowsecurity AS f, pg_get_userbyid(c.relowner) AS dono
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE (n.nspname || '.' || c.relname) IN (:t) ORDER BY 1`, { t: TABELAS }))[0];

async function cenario(t) {
  const a = await um(t, 'SELECT c.id, c.group_id FROM core.companies c JOIN core.groups g ON g.id = c.group_id WHERE g.name = :g AND c.name = :c', { g: TENANTS[0].groupName, c: TENANTS[0].companyName });
  assert.ok(a, 'empresa A do seed CI não encontrada');
  const b = await um(t, "INSERT INTO core.companies (id, group_id, name, status) VALUES (gen_random_uuid(), :g, :n, 'ACTIVE') RETURNING id, group_id", { g: a.group_id, n: `Rodada 4 dono comum B ${crypto.randomUUID()}` });
  const pessoa = await um(t, 'INSERT INTO people.persons (id, group_id, company_id, legal_name) VALUES (gen_random_uuid(), :g, :c, :n) RETURNING id', { g: a.group_id, c: a.id, n: 'Pessoa dono comum' });
  const conversa = await um(t, "INSERT INTO crm.conversations (group_id, company_id, person_id, channel) VALUES (:g, :c, :p, 'WHATSAPP') RETURNING id", { g: a.group_id, c: a.id, p: pessoa.id });
  return { A: { ...a, conversa: conversa.id }, B: b };
}

const mensagem = (t, de, { conversa = null, externo = null } = {}) => um(t, `INSERT INTO crm.messages (id, group_id, company_id, direction, author_type, channel, status, conversation_id, external_message_id)
  VALUES (gen_random_uuid(), :g, :c, 'INBOUND', 'CLIENT', 'WHATSAPP', 'RECEIVED', :cv, :e) RETURNING id`, { g: de.group_id, c: de.id, cv: conversa, e: externo });

test('dono comum: 9971 e 9976 conferem as linhas de todas as empresas sem superusuário nem BYPASSRLS, param no dado cruzado e criam as chaves', { skip: SEM_ADMIN }, async () => {
  const t = await sequelize.transaction();
  try {
    const { A, B } = await cenario(t);
    const papel = await donoComum(t);
    // estado da homologação antes da 9971: sem as chaves dela, e uma mensagem de B com a conversa de A (gravada pela API antiga)
    await m9971.down(qi(t));
    const cruzada = await mensagem(t, B, { conversa: A.conversa });
    const [[admin]] = await q(t, 'SELECT count(*)::int AS total, count(conversation_id)::int AS com_conversa FROM crm.messages');
    assert.ok(admin.total > 0);

    const atributos = await comoDono(t, papel, () => um(t, 'SELECT current_user AS u, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'));
    assert.deepEqual(atributos, { u: papel, rolsuper: false, rolbypassrls: false }, 'a migration roda como o dono comum');
    assert.ok((await forcados(t)).every((l) => l.f && l.dono === papel), 'as três tabelas são do dono comum e têm FORCE RLS');
    const cego = await comoDono(t, papel, () => um(t, 'SELECT count(*)::int AS n FROM crm.messages'));
    assert.equal(cego.n, 0, 'sem o desvio, o dono com FORCE RLS e sem contexto de empresa não vê nenhuma mensagem');

    // 9971 como dono comum: a conferência vê a linha cruzada e o total do superusuário, e PARA
    await comoDono(t, papel, () => assert.rejects(m9971.up(qi(t)), (e) => {
      assert.match(e.message, /^\[20260101009971\] PARADA sem alterar nada\./);
      assert.match(e.message, new RegExp(`conversation_id: 1 de ${admin.com_conversa} mensagem\\(ns\\) com conversa de outra empresa`));
      return true;
    }));
    assert.ok((await forcados(t)).every((l) => l.f), 'parada: o FORCE RLS continua ligado');
    const [[{ n: chaves0 }]] = await q(t, 'SELECT count(*)::int AS n FROM pg_constraint WHERE conname IN (:c)', { c: [m9971.FK_CONVERSA, m9971.FK_MIDIA] });
    assert.equal(chaves0, 0, 'parada: nenhuma chave criada');
    // corrigida a linha (quem decide tira a conversa de A da mensagem de B), a 9971 cria as chaves como dono comum
    await q(t, 'UPDATE crm.messages SET conversation_id = NULL WHERE id = :id', { id: cruzada.id });
    await comoDono(t, papel, () => m9971.up(qi(t)));
    const [chaves] = await q(t, 'SELECT conname, convalidated FROM pg_constraint WHERE conname IN (:c) ORDER BY 1', { c: [m9971.FK_CONVERSA, m9971.FK_MIDIA, ...m9971.ALVOS.map((x) => x.unique)] });
    assert.equal(chaves.length, 4);
    assert.ok(chaves.every((c) => c.convalidated), 'as quatro chaves validadas');
    assert.ok((await forcados(t)).every((l) => l.f), 'depois da 9971: FORCE RLS ligado');

    // 9976 como dono comum: o mesmo id externo em A e em B (o índice por empresa permite); o down vê as duas empresas e PARA
    const id = `wamid.dono-comum-${crypto.randomUUID()}`;
    await mensagem(t, A, { externo: id });
    const deB = await mensagem(t, B, { externo: id });
    const [[ext]] = await q(t, 'SELECT count(*)::int AS n, count(DISTINCT company_id)::int AS e FROM crm.messages WHERE external_message_id IS NOT NULL AND connection_id IS NULL');
    const esperado = await compartilhados(t); // o deste teste e os que outros testes do mesmo banco já gravaram, contados pelo superusuário
    assert.ok(ext.e >= 2 && esperado.ids >= 1);
    await comoDono(t, papel, () => assert.rejects(m9976.down(qi(t)), (e) => {
      assert.match(e.message, new RegExp(`crm\\.messages: ${ext.n} mensagem\\(ns\\) com id externo sem connection, em ${ext.e} empresa\\(s\\)`), 'a conferência conta as linhas de todas as empresas');
      assert.match(e.message, new RegExp(`; ${esperado.ids} id\\(s\\) usado\\(s\\) por mais de uma empresa \\(${esperado.mensagens} mensagem\\(ns\\)\\)`));
      return true;
    }));
    const idx = async () => (await q(t, "SELECT indexname FROM pg_indexes WHERE schemaname = 'crm' AND indexname IN (:n) ORDER BY 1", { n: [m9976.GLOBAL, m9976.POR_EMPRESA] }))[0].map((l) => l.indexname);
    assert.deepEqual(await idx(), [m9976.POR_EMPRESA], 'parada: o índice por empresa continua');
    await q(t, 'UPDATE crm.messages SET external_message_id = :e WHERE id = :id', { e: `${id}-b`, id: deB.id });
    await resolverCompartilhados(t);
    await comoDono(t, papel, () => m9976.down(qi(t)));
    assert.deepEqual(await idx(), [m9976.GLOBAL], 'resolvido: o down volta o índice global');
    await comoDono(t, papel, () => m9976.up(qi(t)));
    assert.deepEqual(await idx(), [m9976.POR_EMPRESA], 'o up cria o índice por empresa como dono comum');
    assert.ok((await forcados(t)).every((l) => l.f && l.dono === papel), 'no fim: FORCE RLS ligado nas três tabelas');
  } finally {
    await t.rollback();
  }
});
