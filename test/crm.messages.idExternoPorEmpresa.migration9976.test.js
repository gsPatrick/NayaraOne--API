'use strict';

// Rodada 4 da verificação independente do Marco 9 (12/11/2026; DI-M9R-10) — migration 20260101009976: o id externo da mensagem do CRM sem
// connection é único POR EMPRESA (antes, o índice da 675 valia para o banco inteiro e a empresa B recebia 409 com o id de uma mensagem de A).
// O que se prova aqui, no banco descartável, com o dono das tabelas (DDL):
// - com todas as migrations aplicadas, existe o índice por empresa e não existe mais o global;
// - o banco aceita o mesmo id externo em A e em B e recusa (23505, índice por empresa) a repetição na mesma empresa;
// - o `down` com um id usado por duas empresas PARA sem alterar nada e informa as contagens; resolvido, volta o índice global;
// - o `up` com id repetido na mesma empresa (só possível sem nenhum dos dois índices) PARA sem alterar nada;
// - ida e volta e `up` repetido não falham, e o FORCE RLS da tabela fica como estava.
// Tudo dentro de uma transação de fora com rollback: a transação da migration vira um savepoint dela, então nada fica no banco.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Sequelize } = require('sequelize');
const migracao = require('../migrations/20260101009976-mensagens-id-externo-unico-por-empresa');
const { TENANTS } = require('../scripts/seed-ci-two-tenants');

const ADMIN = process.env.DATABASE_ADMIN_URL;
const SEM_ADMIN = ADMIN ? false : 'DDL exige o dono das tabelas: só roda com DATABASE_ADMIN_URL (scripts/withDisposableDb.js).';
const sequelize = ADMIN ? new Sequelize(ADMIN, { logging: false }) : null;

after(async () => { if (sequelize) await sequelize.close(); });

const qi = (externa) => ({ sequelize: { transaction: (cb) => sequelize.transaction({ transaction: externa }, cb), query: (sql, o) => sequelize.query(sql, o) } });

async function emTransacao(fn) {
  const t = await sequelize.transaction();
  try { await fn(t); } finally { await t.rollback(); }
}

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

/** Índices de id externo de crm.messages: nome -> definição. */
async function indices(t) {
  const [linhas] = await q(t, "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'crm' AND tablename = 'messages' AND indexname IN (:n)", { n: [migracao.GLOBAL, migracao.POR_EMPRESA] });
  return Object.fromEntries(linhas.map((l) => [l.indexname, l.indexdef]));
}

const forcado = async (t) => (await um(t, "SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'crm.messages'::regclass")).f;

async function tentar(t, fn) {
  await q(t, 'SAVEPOINT tentativa');
  try {
    await fn();
    await q(t, 'RELEASE SAVEPOINT tentativa');
    return null;
  } catch (erro) {
    await q(t, 'ROLLBACK TO SAVEPOINT tentativa');
    const pg = erro.parent || erro.original || erro;
    return `${pg.code} ${pg.constraint || pg.message}`;
  }
}

/** Empresa A (do seed) e B (nova, mesmo grupo). */
async function cenario(t) {
  const A = await um(t, 'SELECT c.id, c.group_id FROM core.companies c JOIN core.groups g ON g.id = c.group_id WHERE g.name = :g AND c.name = :c', { g: TENANTS[0].groupName, c: TENANTS[0].companyName });
  assert.ok(A, 'empresa A do seed CI não encontrada');
  const B = await um(t, "INSERT INTO core.companies (id, group_id, name, status) VALUES (gen_random_uuid(), :g, :n, 'ACTIVE') RETURNING id, group_id", { g: A.group_id, n: `Rodada 4 9976 B ${crypto.randomUUID()}` });
  return { A, B };
}

const mensagem = (t, de, externo) => um(t, `INSERT INTO crm.messages (id, group_id, company_id, direction, author_type, channel, status, external_message_id)
  VALUES (gen_random_uuid(), :g, :c, 'INBOUND', 'CLIENT', 'WHATSAPP', 'RECEIVED', :e) RETURNING id`, { g: de.group_id, c: de.id, e: externo });

const DEF = 'CREATE UNIQUE INDEX crm_messages_company_external_id_uq ON crm.messages USING btree (company_id, external_message_id) WHERE ((external_message_id IS NOT NULL) AND (connection_id IS NULL))';

test('9976: com todas as migrations, o índice do id externo sem connection é por empresa e o global não existe mais', { skip: SEM_ADMIN }, async () => {
  await emTransacao(async (t) => {
    assert.deepEqual(await indices(t), { [migracao.POR_EMPRESA]: DEF });
  });
});

test('9976: o banco aceita o mesmo id externo em A e em B e recusa a repetição na mesma empresa (23505 do índice por empresa)', { skip: SEM_ADMIN }, async () => {
  await emTransacao(async (t) => {
    const { A, B } = await cenario(t);
    const id = `wamid.9976-${crypto.randomUUID()}`;
    assert.equal(await tentar(t, () => mensagem(t, A, id)), null);
    assert.equal(await tentar(t, () => mensagem(t, B, id)), null, 'o mesmo id em outra empresa é outra mensagem');
    assert.equal(await tentar(t, () => mensagem(t, B, id)), `23505 ${migracao.POR_EMPRESA}`, 'na mesma empresa o id continua único');
  });
});

test('9976: o down com id usado por duas empresas PARA sem alterar nada e informa as contagens; resolvido, volta o índice global', { skip: SEM_ADMIN }, async () => {
  await emTransacao(async (t) => {
    const { A, B } = await cenario(t);
    const id = `wamid.9976-${crypto.randomUUID()}`;
    await mensagem(t, A, id);
    const deB = await mensagem(t, B, id);
    const antes = await forcado(t);
    const esperado = await compartilhados(t); // o deste teste e os que outros testes do mesmo banco já gravaram
    assert.ok(esperado.ids >= 1);
    await assert.rejects(migracao.down(qi(t)), (e) => {
      assert.match(e.message, /^\[20260101009976\] PARADA sem alterar nada\. Conferência antes de voltar ao índice global/);
      assert.match(e.message, new RegExp(`; ${esperado.ids} id\\(s\\) usado\\(s\\) por mais de uma empresa \\(${esperado.mensagens} mensagem\\(ns\\)\\)`));
      return true;
    });
    assert.deepEqual(await indices(t), { [migracao.POR_EMPRESA]: DEF }, 'parada: o índice por empresa continua e o global não volta');
    assert.equal(await forcado(t), antes, 'parada: o FORCE RLS fica como estava');
    const [[{ n }]] = await q(t, 'SELECT count(*)::int AS n FROM crm.messages WHERE external_message_id = :e', { e: id });
    assert.equal(n, 2, 'parada: nenhuma linha some');
    // quem decide dá outro id à mensagem de B (e resolve os demais compartilhados): o down passa e o global volta
    await q(t, 'UPDATE crm.messages SET external_message_id = :e WHERE id = :id', { e: `${id}-b`, id: deB.id });
    await resolverCompartilhados(t);
    await migracao.down(qi(t));
    assert.deepEqual(Object.keys(await indices(t)), [migracao.GLOBAL]);
    assert.equal(await tentar(t, () => mensagem(t, B, id)), `23505 ${migracao.GLOBAL}`, 'sem a 9976 o id é único no banco inteiro');
    assert.equal(await forcado(t), antes);
  });
});

test('9976: o up com id repetido na mesma empresa PARA sem alterar nada; ida e volta e up repetido não falham', { skip: SEM_ADMIN }, async () => {
  await emTransacao(async (t) => {
    const { A } = await cenario(t);
    await resolverCompartilhados(t);
    await migracao.down(qi(t));
    await q(t, `DROP INDEX crm.${migracao.GLOBAL}`); // só sem nenhum dos dois índices dá para repetir o id na mesma empresa
    const id = `wamid.9976-${crypto.randomUUID()}`;
    await mensagem(t, A, id);
    const repetida = await mensagem(t, A, id);
    await assert.rejects(migracao.up(qi(t)), /^Error: \[20260101009976\] PARADA sem alterar nada\. .*1 id\(s\) repetido\(s\) na mesma empresa/);
    assert.deepEqual(await indices(t), {}, 'parada: nenhum índice criado');
    await q(t, 'UPDATE crm.messages SET external_message_id = NULL WHERE id = :id', { id: repetida.id });
    await migracao.up(qi(t));
    assert.deepEqual(await indices(t), { [migracao.POR_EMPRESA]: DEF });
    await migracao.up(qi(t)); // up repetido
    assert.deepEqual(await indices(t), { [migracao.POR_EMPRESA]: DEF });
    await migracao.down(qi(t));
    await migracao.up(qi(t));
    assert.deepEqual(await indices(t), { [migracao.POR_EMPRESA]: DEF });
  });
});
