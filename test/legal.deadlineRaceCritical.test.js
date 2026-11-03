'use strict';

/**
 * Corrida entre duas conexoes reais (verificador independente): reabrir um prazo CRITICAL concluido
 * enquanto outra transacao tira o escalonamento do processo. Sem lock do processo (FOR UPDATE), as
 * duas commitavam e sobrava PENDING + CRITICAL sem escalonamento.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withTenantTransaction, uniqueSuffix } = require('./testHelpers');
const legalCasesService = require('../src/features/legal/legalCases.service');
const legalDeadlinesService = require('../src/features/legal/legalDeadlines.service');
const { LegalDeadline, LegalCase } = require('../src/models');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
});
after(async () => {
  await sequelize.close();
});

const FUTURE = () => new Date(Date.now() + 20 * 86400000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function begin() {
  const tx = await sequelize.transaction();
  await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: tx });
  await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: tx });
  await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: tx });
  return tx;
}

/**
 * Duas conexoes reais: A executa e fica com a transacao ABERTA; B executa enquanto A segue aberta
 * (com o lock, B espera A); so depois A commita e B termina. Sem lock, as duas passam e commitam.
 */
async function race(opA, txA, opB, txB) {
  const outcome = async (op, tx) => {
    try {
      await op();
      return { ok: true };
    } catch (err) {
      await tx.rollback().catch(() => {});
      return { ok: false, status: err.statusCode, code: err.code, message: err.message };
    }
  };
  const a = await outcome(opA, txA);
  const pendingB = outcome(opB, txB);
  await sleep(250);
  if (a.ok) await txA.commit();
  const b = await pendingB;
  if (b.ok) await txB.commit();
  return [a, b];
}

async function setupConcluded() {
  const out = {};
  await withTenantTransaction(tenant, async (tx) => {
    out.legalCase = await legalCasesService.createLegalCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', summary: `Corrida ${uniqueSuffix()}`, responsibleUserId: tenant.userId, escalationUserId: tenant.userId },
      tenant.userId,
      tx
    );
    out.d = await legalDeadlinesService.createLegalDeadline(
      out.legalCase.id,
      { description: `Critico ${uniqueSuffix()}`, dueAt: FUTURE(), sourceEvent: 'teste', criticality: 'CRITICAL' },
      tenant.userId,
      tx
    );
    await legalDeadlinesService.updateLegalDeadline(out.d.id, { status: 'DONE', conclusionNote: 'Feito.' }, tenant.userId, tx);
  });
  return out;
}

async function finalState({ legalCase, d }) {
  const out = {};
  await withTenantTransaction(tenant, async (tx) => {
    out.deadline = await LegalDeadline.findByPk(d.id, { transaction: tx });
    out.legalCase = await LegalCase.findByPk(legalCase.id, { transaction: tx });
  });
  return out;
}

function assertValid({ deadline, legalCase }) {
  const brokenCritical = deadline.status === 'PENDING' && deadline.criticality === 'CRITICAL' && !legalCase.escalationUserId;
  assert.equal(brokenCritical, false, 'sobrou prazo CRITICAL pendente sem escalonamento');
}

for (let round = 1; round <= 8; round += 1) {
  test(`Corrida #${round}: reabrir CRITICAL x tirar escalonamento (duas conexoes) -> um lado recebe 422 e o estado final e valido`, async () => {
    const fx = await setupConcluded();
    const t1 = await begin();
    const t2 = await begin();
    // alterna quem comeca, para cobrir as duas ordens de chegada
    const reopen = () => legalDeadlinesService.updateLegalDeadline(fx.d.id, { status: 'PENDING' }, tenant.userId, t1);
    const removeEscalation = () => legalCasesService.updateLegalCase(fx.legalCase.id, { escalationUserId: null }, tenant.userId, t2);
    const results = round % 2 ? await race(reopen, t1, removeEscalation, t2) : (await race(removeEscalation, t2, reopen, t1)).reverse();
    const rejected = results.filter((r) => !r.ok);
    assert.equal(rejected.length, 1, `exatamente um lado deve ser recusado: ${JSON.stringify(results)}`);
    assert.equal(rejected[0].status, 422, JSON.stringify(rejected[0]));
    assertValid(await finalState(fx));
  });
}

test('Corrida: criar CRITICAL novo x tirar escalonamento do processo -> um lado recebe 422 e o estado final e valido', async () => {
  for (let round = 0; round < 6; round += 1) {
    const fx = await setupConcluded();
    const t1 = await begin();
    const t2 = await begin();
    const create = () => legalDeadlinesService.createLegalDeadline(fx.legalCase.id, { description: `Novo ${uniqueSuffix()}`, dueAt: FUTURE(), sourceEvent: 'teste', criticality: 'CRITICAL' }, tenant.userId, t1);
    const remove = () => legalCasesService.updateLegalCase(fx.legalCase.id, { escalationUserId: null }, tenant.userId, t2);
    const results = round % 2 ? await race(create, t1, remove, t2) : await race(remove, t2, create, t1);
    assert.equal(results.filter((r) => !r.ok).length, 1, JSON.stringify(results));
    assert.equal(results.find((r) => !r.ok).status, 422);
    await withTenantTransaction(tenant, async (tx) => {
      const c = await LegalCase.findByPk(fx.legalCase.id, { transaction: tx });
      const pend = await LegalDeadline.count({ where: { legalCaseId: c.id, status: 'PENDING', criticality: 'CRITICAL' }, transaction: tx });
      assert.equal(pend > 0 && !c.escalationUserId, false);
    });
  }
});

test('Positivo: sem concorrencia, reabrir CRITICAL com escalonamento mantido e remover escalonamento sem CRITICAL pendente funcionam', async () => {
  const fx = await setupConcluded();
  await withTenantTransaction(tenant, async (tx) => {
    const re = await legalDeadlinesService.updateLegalDeadline(fx.d.id, { status: 'PENDING' }, tenant.userId, tx);
    assert.equal(re.status, 'PENDING');
    await legalDeadlinesService.updateLegalDeadline(fx.d.id, { status: 'DONE', conclusionNote: 'De novo.' }, tenant.userId, tx);
    const upd = await legalCasesService.updateLegalCase(fx.legalCase.id, { escalationUserId: null }, tenant.userId, tx);
    assert.equal(upd.escalationUserId, null);
  });
});
