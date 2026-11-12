'use strict';

// ISO-R2 (verificação independente do Marco 9, rodada 3, 12/11/2026; DI-M9R-7) — migration 20260101009971: a mensagem do CRM só aponta para
// conversa e mídia em quarentena da MESMA empresa (FKs compostas com company_id, como a 9966 nos filhos de Pessoas).
// O que se prova aqui, no banco descartável, com o dono das tabelas (DDL):
// - com todas as migrations aplicadas, as duas FKs compostas e os dois UNIQUE de apoio existem, validados;
// - o banco recusa (23503) a mensagem da empresa B com a conversa ou a mídia da empresa A, e aceita as da própria empresa;
// - com uma linha cruzada já gravada (legado, antes da migration), o `up` PARA sem alterar nada e informa a contagem;
//   depois de corrigir a linha, o `up` passa;
// - ida e volta: `down` remove só o que a migration cria (a FK simples da 679 continua), `up` recria, e rodar o `up` de novo não falha.
// Tudo dentro de uma transação de fora com rollback: a transação da migration vira um savepoint dela, então nada fica no banco.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Sequelize } = require('sequelize');
const migracao = require('../migrations/20260101009971-mensagens-so-com-conversa-e-midia-da-mesma-empresa');
const { TENANTS } = require('../scripts/seed-ci-two-tenants');

const ADMIN = process.env.DATABASE_ADMIN_URL;
const SEM_ADMIN = ADMIN ? false : 'DDL exige o dono das tabelas: só roda com DATABASE_ADMIN_URL (scripts/withDisposableDb.js).';
const sequelize = ADMIN ? new Sequelize(ADMIN, { logging: false }) : null;

after(async () => { if (sequelize) await sequelize.close(); });

const CHAVES = [migracao.FK_CONVERSA, migracao.FK_MIDIA, ...migracao.ALVOS.map((a) => a.unique)];

/** queryInterface da migration presa à transação de fora: a transação dela vira savepoint (o erro desfaz só o savepoint). */
const qi = (externa) => ({ sequelize: { transaction: (cb) => sequelize.transaction({ transaction: externa }, cb), query: (sql, o) => sequelize.query(sql, o) } });

async function emTransacao(fn) {
  const t = await sequelize.transaction();
  try { await fn(t); } finally { await t.rollback(); }
}

const q = (t, sql, replacements = {}) => sequelize.query(sql, { replacements, transaction: t });
const um = async (t, sql, r) => (await q(t, sql, r))[0][0];

async function chaves(t) {
  const [linhas] = await q(t, `SELECT con.conname, con.convalidated, pg_get_constraintdef(con.oid) AS def FROM pg_constraint con
    WHERE con.conname IN (:n) OR (con.conrelid = 'crm.messages'::regclass AND con.conname = 'messages_conversation_id_fkey')`, { n: CHAVES });
  return Object.fromEntries(linhas.map((l) => [l.conname, l]));
}

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

/** Empresa A (do seed) e B (nova, mesmo grupo); pessoa, conversa e mídia em quarentena de cada uma. Tudo na transação de fora. */
async function cenario(t) {
  const a = await um(t, `SELECT c.id, c.group_id FROM core.companies c JOIN core.groups g ON g.id = c.group_id WHERE g.name = :g AND c.name = :c`,
    { g: TENANTS[0].groupName, c: TENANTS[0].companyName });
  assert.ok(a, 'empresa A do seed CI não encontrada');
  const b = await um(t, "INSERT INTO core.companies (id, group_id, name, status) VALUES (gen_random_uuid(), :g, :n, 'ACTIVE') RETURNING id, group_id", { g: a.group_id, n: `ISO-R2 9971 B ${crypto.randomUUID()}` });
  const daEmpresa = async (empresa) => {
    const pessoa = await um(t, 'INSERT INTO people.persons (id, group_id, company_id, legal_name) VALUES (gen_random_uuid(), :g, :c, :n) RETURNING id', { g: empresa.group_id, c: empresa.id, n: 'Pessoa ISO-R2 9971' });
    const conversa = await um(t, "INSERT INTO crm.conversations (group_id, company_id, person_id, channel) VALUES (:g, :c, :p, 'WHATSAPP') RETURNING id", { g: empresa.group_id, c: empresa.id, p: pessoa.id });
    const midia = await um(t, `INSERT INTO files.quarantine (group_id, company_id, origin_key, size_bytes, sha256, expires_at)
      VALUES (:g, :c, :o, 10, :h, now() + interval '1 day') RETURNING id`, { g: empresa.group_id, c: empresa.id, o: `iso-r2-9971/${crypto.randomUUID()}`, h: crypto.randomBytes(32).toString('hex') });
    return { ...empresa, pessoa: pessoa.id, conversa: conversa.id, midia: midia.id };
  };
  return { A: await daEmpresa(a), B: await daEmpresa(b) };
}

/** Mensagem da empresa `de`, citando a conversa e/ou a mídia informadas. */
const mensagem = (t, de, { conversa = null, midia = null } = {}) => um(t, `INSERT INTO crm.messages (id, group_id, company_id, direction, author_type, channel, status, conversation_id, media_quarantine_id)
  VALUES (gen_random_uuid(), :g, :c, 'INBOUND', 'CLIENT', 'WHATSAPP', 'RECEIVED', :cv, :m) RETURNING id`, { g: de.group_id, c: de.id, cv: conversa, m: midia });

test('9971: as FKs compostas e os UNIQUE de apoio existem, validados, e a FK simples da 679 continua', { skip: SEM_ADMIN }, async () => {
  await emTransacao(async (t) => {
    const c = await chaves(t);
    for (const n of CHAVES) assert.ok(c[n] && c[n].convalidated, `${n} precisa existir e estar validada`);
    assert.equal(c[migracao.FK_CONVERSA].def, 'FOREIGN KEY (conversation_id, company_id) REFERENCES crm.conversations(id, company_id) ON DELETE SET NULL (conversation_id)');
    assert.equal(c[migracao.FK_MIDIA].def, 'FOREIGN KEY (media_quarantine_id, company_id) REFERENCES files.quarantine(id, company_id)');
    assert.ok(c.messages_conversation_id_fkey, 'a FK simples da 679 continua');
  });
});

test('9971: o banco recusa a mensagem de B com a conversa ou a mídia de A e aceita as da própria empresa', { skip: SEM_ADMIN }, async () => {
  await emTransacao(async (t) => {
    const { A, B } = await cenario(t);
    assert.equal(await tentar(t, () => mensagem(t, B, { conversa: A.conversa })), `23503 ${migracao.FK_CONVERSA}`);
    assert.equal(await tentar(t, () => mensagem(t, B, { midia: A.midia })), `23503 ${migracao.FK_MIDIA}`);
    assert.equal(await tentar(t, () => mensagem(t, B, { midia: crypto.randomUUID() })), `23503 ${migracao.FK_MIDIA}`, 'mídia inexistente também é recusada');
    assert.equal(await tentar(t, () => mensagem(t, B, { conversa: B.conversa, midia: B.midia })), null, 'as da própria empresa são aceitas');
    assert.equal(await tentar(t, () => mensagem(t, A, { conversa: A.conversa, midia: A.midia })), null);
  });
});

test('9971: com linha cruzada gravada antes, o up PARA sem alterar nada e informa a contagem; corrigida a linha, o up passa', { skip: SEM_ADMIN }, async () => {
  await emTransacao(async (t) => {
    const { A, B } = await cenario(t);
    await migracao.down(qi(t));
    assert.deepEqual(Object.keys(await chaves(t)), ['messages_conversation_id_fkey'], 'sem a 9971 só sobra a FK simples');
    // legado: sem a 9971 o banco aceita a mensagem de B com a conversa de A (a FK simples não passa pelo RLS) e com mídia de A ou inexistente
    const cruzada = await mensagem(t, B, { conversa: A.conversa });
    const midiaDeA = await mensagem(t, B, { midia: A.midia });
    const midiaSumida = await mensagem(t, B, { midia: crypto.randomUUID() });
    const [[forcadoAntes]] = await q(t, "SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'crm.messages'::regclass");

    await assert.rejects(migracao.up(qi(t)), (e) => {
      assert.match(e.message, /^\[20260101009971\] PARADA sem alterar nada\./);
      assert.match(e.message, /conversation_id: 1 de \d+ mensagem\(ns\) com conversa de outra empresa/);
      assert.match(e.message, /media_quarantine_id: 1 de \d+ com mídia de outra empresa e 1 com mídia inexistente/);
      return true;
    });
    assert.deepEqual(Object.keys(await chaves(t)), ['messages_conversation_id_fkey'], 'parada: nenhuma chave criada');
    const [[forcadoDepois]] = await q(t, "SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'crm.messages'::regclass");
    assert.equal(forcadoDepois.f, forcadoAntes.f, 'parada: o FORCE RLS da tabela fica como estava');
    const [[ainda]] = await q(t, 'SELECT count(*)::int AS n FROM crm.messages WHERE id IN (:ids)', { ids: [cruzada.id, midiaDeA.id, midiaSumida.id] });
    assert.equal(ainda.n, 3, 'parada: nenhuma linha some');

    // corrigida só a conversa: ainda para, agora só pela mídia
    await q(t, 'UPDATE crm.messages SET conversation_id = :c WHERE id = :id', { c: B.conversa, id: cruzada.id });
    await assert.rejects(migracao.up(qi(t)), /conversation_id: 0 de \d+ .*media_quarantine_id: 1 de \d+ com mídia de outra empresa e 1 com mídia inexistente/);
    // corrigida a mídia (quem decide aponta para a mídia da própria empresa ou tira a referência): passa
    await q(t, 'UPDATE crm.messages SET media_quarantine_id = :m WHERE id = :id', { m: B.midia, id: midiaDeA.id });
    await q(t, 'UPDATE crm.messages SET media_quarantine_id = NULL WHERE id = :id', { id: midiaSumida.id });
    await migracao.up(qi(t));
    const c = await chaves(t);
    for (const n of CHAVES) assert.ok(c[n] && c[n].convalidated, `${n} criada e validada depois da correção`);
    assert.equal(await tentar(t, () => mensagem(t, B, { conversa: A.conversa })), `23503 ${migracao.FK_CONVERSA}`, 'depois do up a linha cruzada é recusada');
  });
});

test('9971: ida e volta — down remove só as chaves dela, up recria, e o up repetido não falha', { skip: SEM_ADMIN }, async () => {
  await emTransacao(async (t) => {
    await migracao.down(qi(t));
    assert.deepEqual(Object.keys(await chaves(t)), ['messages_conversation_id_fkey']);
    await migracao.down(qi(t)); // down repetido não falha
    await migracao.up(qi(t));
    let c = await chaves(t);
    for (const n of CHAVES) assert.ok(c[n] && c[n].convalidated, `${n} recriada`);
    await migracao.up(qi(t));
    c = await chaves(t);
    for (const n of CHAVES) assert.ok(c[n] && c[n].convalidated, `${n} continua depois do up repetido`);
    const { A } = await cenario(t);
    // ON DELETE da conversa: a mensagem fica, só perde a conversa (mesma ação da FK simples da 679); a empresa da mensagem não muda
    const m = await mensagem(t, A, { conversa: A.conversa });
    await q(t, 'DELETE FROM crm.conversations WHERE id = :id', { id: A.conversa });
    const depois = await um(t, 'SELECT conversation_id, company_id FROM crm.messages WHERE id = :id', { id: m.id });
    assert.deepEqual([depois.conversation_id, depois.company_id], [null, A.id]);
  });
});
