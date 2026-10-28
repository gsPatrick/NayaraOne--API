'use strict';

/**
 * M9-D204 (correção da reabertura): duas transações concorrentes publicando a MESMA
 * idempotency_key. A segunda não pode estourar SequelizeUniqueConstraintError (derrubaria a
 * transação de negócio dela): republicar é no-op e devolve o evento da primeira.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize } = require('sequelize');
const { sequelize, getSeedTenant, uniqueSuffix } = require('../testHelpers');
const { OutboxEvent } = require('../../src/models');
const { publishDomainEvent } = require('../../src/engines/events/outbox');

let tenant;
const criados = [];

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  if (criados.length && process.env.DATABASE_ADMIN_URL) {
    const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
    await admin.query('DELETE FROM integration.outbox_events WHERE id IN (:ids)', { replacements: { ids: criados } });
    await admin.close();
  }
  await sequelize.close();
});

async function abreTransacao() {
  const t = await sequelize.transaction();
  await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
  await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
  await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
  return t;
}

function evento(chave, valor) {
  return {
    groupId: tenant.groupId,
    companyId: tenant.companyId,
    aggregateType: 'Contract',
    aggregateId: tenant.userId,
    eventType: 'qa_m9.contrato_assinado',
    payload: { valor },
    idempotencyKey: chave,
  };
}

test('outbox_republicar_mesma_chave_concorrente_e_noop', async () => {
  const chave = `qa-m9-d204:conc:${uniqueSuffix()}`;
  const t1 = await abreTransacao();
  const t2 = await abreTransacao();
  try {
    const a = await publishDomainEvent(evento(chave, 'primeiro'), t1);
    criados.push(a.id);
    // t2 bloqueia na chave única até t1 decidir; commit de t1 libera o conflito.
    const pendente = publishDomainEvent(evento(chave, 'segundo'), t2);
    await new Promise((r) => setTimeout(r, 300));
    await t1.commit();
    const b = await pendente;
    assert.equal(b.id, a.id, 'a segunda publicação devolve o evento da primeira');
    await t2.commit();
  } catch (err) {
    await t1.rollback().catch(() => {});
    await t2.rollback().catch(() => {});
    throw err;
  }
  const t3 = await abreTransacao();
  try {
    const linhas = await OutboxEvent.findAll({ where: { idempotencyKey: chave }, transaction: t3 });
    assert.equal(linhas.length, 1);
    assert.deepEqual(linhas[0].payloadJson, { valor: 'primeiro' }, 'o primeiro vence');
  } finally {
    await t3.rollback();
  }
});

test('outbox_conflito_nao_derruba_a_transacao_de_negocio_do_segundo_chamador', async () => {
  const chave = `qa-m9-d204:conc2:${uniqueSuffix()}`;
  const t1 = await abreTransacao();
  const t2 = await abreTransacao();
  try {
    const a = await publishDomainEvent(evento(chave, 'x'), t1);
    criados.push(a.id);
    const pendente = publishDomainEvent(evento(chave, 'y'), t2);
    await new Promise((r) => setTimeout(r, 300));
    await t1.commit();
    await pendente;
    // a transação do segundo segue utilizável (sem "current transaction is aborted")
    const [[{ ok }]] = await sequelize.query('SELECT 1 AS ok', { transaction: t2 });
    assert.equal(ok, 1);
    await t2.commit();
  } catch (err) {
    await t1.rollback().catch(() => {});
    await t2.rollback().catch(() => {});
    throw err;
  }
});
