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
const { createRaceLog } = require('./legal.raceSessionLog.helpers');

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
async function race(opA, txA, opB, txB, log) {
  const outcome = async (op, tx) => {
    try {
      await op();
      return { ok: true };
    } catch (err) {
      await tx.rollback().catch(() => {});
      return { ok: false, status: err.statusCode, code: err.code, message: err.message };
    }
  };
  // Log nominal (so observa): PID de cada sessao, quem espera por quem e a ordem de commit.
  const sA = log ? await log.session(`A = ${opA.label}`, txA) : null;
  const sB = log ? await log.session(`B = ${opB.label}`, txB) : null;
  const a = await outcome(opA, txA);
  if (log) log.emit(`sessão A executou (${opA.label}) -> ${log.outcome(a)}; transação A segue ${a.ok ? 'ABERTA' : 'encerrada por ROLLBACK'}`);
  const pendingB = outcome(opB, txB);
  if (log) log.emit(`sessão B disparou (${opB.label}) com a transação A ${a.ok ? 'aberta' : 'já encerrada'}`);
  await sleep(250);
  if (log) await log.observe(sB, { [sA.pid]: sA, [sB.pid]: sB });
  if (a.ok) await txA.commit();
  if (log) log.emit(a.ok ? 'sessão A COMMIT (1º commit)' : 'sessão A sem commit (recusada)');
  const b = await pendingB;
  if (log) log.emit(`sessão B terminou -> ${log.outcome(b)}`);
  if (b.ok) await txB.commit();
  if (log) log.emit(b.ok ? 'sessão B COMMIT' : 'sessão B ROLLBACK (recusada, nada gravado)');
  return [a, b];
}

const labeled = (label, fn) => Object.assign(fn, { label });

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
    const reopen = labeled('reabrir o prazo CRITICAL (DONE -> PENDING)', () => legalDeadlinesService.updateLegalDeadline(fx.d.id, { status: 'PENDING' }, tenant.userId, t1));
    const removeEscalation = labeled('tirar o escalonamento do processo (escalationUserId = null)', () => legalCasesService.updateLegalCase(fx.legalCase.id, { escalationUserId: null }, tenant.userId, t2));
    const log = createRaceLog(sequelize, `Corrida #${round} (${round % 2 ? 'reabrir primeiro' : 'tirar escalonamento primeiro'})`);
    log.emit(`prazo CRITICAL ${fx.d.id} (DONE), processo ${fx.legalCase.id}`);
    const results = round % 2 ? await race(reopen, t1, removeEscalation, t2, log) : (await race(removeEscalation, t2, reopen, t1, log)).reverse();
    const rejected = results.filter((r) => !r.ok);
    assert.equal(rejected.length, 1, `exatamente um lado deve ser recusado: ${JSON.stringify(results)}`);
    assert.equal(rejected[0].status, 422, JSON.stringify(rejected[0]));
    const fin = await finalState(fx);
    log.emit(`estado final: prazo ${fin.deadline.status}/${fin.deadline.criticality}, escalonamento do processo = ${fin.legalCase.escalationUserId || 'nenhum'}`);
    assertValid(fin);
  });
}

test('Corrida: criar CRITICAL novo x tirar escalonamento do processo -> um lado recebe 422 e o estado final e valido', async () => {
  for (let round = 0; round < 6; round += 1) {
    const fx = await setupConcluded();
    const t1 = await begin();
    const t2 = await begin();
    const create = labeled('criar prazo CRITICAL novo', () => legalDeadlinesService.createLegalDeadline(fx.legalCase.id, { description: `Novo ${uniqueSuffix()}`, dueAt: FUTURE(), sourceEvent: 'teste', criticality: 'CRITICAL' }, tenant.userId, t1));
    const remove = labeled('tirar o escalonamento do processo (escalationUserId = null)', () => legalCasesService.updateLegalCase(fx.legalCase.id, { escalationUserId: null }, tenant.userId, t2));
    const log = createRaceLog(sequelize, `Criar CRITICAL x tirar escalonamento, rodada ${round + 1} (${round % 2 ? 'criar primeiro' : 'tirar primeiro'})`);
    log.emit(`processo ${fx.legalCase.id}`);
    const results = round % 2 ? await race(create, t1, remove, t2, log) : await race(remove, t2, create, t1, log);
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
