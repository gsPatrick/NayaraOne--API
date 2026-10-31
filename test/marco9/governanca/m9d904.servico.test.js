'use strict';

// M9-D904 — avançar e reverter o canary de um setor: etapas, gates da Torre, isolamento entre setores, rollback em um passo, flag como única fonte do estado. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d904Env');

let A;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) { A = (await env.loadTenants()).A; await env.cleanup(A); } });
afterEach(async () => { if (env.DISPOSABLE) await env.cleanup(A); });
after(async () => { await env.sequelize.close(); });

test('m9d904 o setor sobe 5%, 25%, 50% e 100% e a flag é a única fonte do estado', { skip: skip() }, async () => {
  const users = await env.addSectorUsers(A, 'ATENDIMENTO', 20);
  await env.setEntities(A, 'ATENDIMENTO', ['QA904_LEAD']);
  const seen = [];
  for (const expected of [5, 25, 50, 100]) {
    const out = await env.advance(A, 'ATENDIMENTO');
    seen.push([out.previousPercent, out.percent, out.usersInCanary, out.unchanged]);
    assert.equal(await env.percentOf(A, 'ATENDIMENTO'), expected, 'o valor da flag é o percentual');
  }
  assert.deepEqual(seen, [[0, 5, 1, false], [5, 25, 5, false], [25, 50, 10, false], [50, 100, 20, false]]);
  assert.equal((await env.status(A)).sectors.find((s) => s.sector === 'ATENDIMENTO').usersTotal, users.length);
  const row = await env.flagRow(A, 'ATENDIMENTO');
  assert.deepEqual([row.key, row.scope, row.scope_ref, row.risk, row.value_type, row.version, row.kind], ['migracao.setor.atendimento.novo_sistema', 'SECTOR', 'ATENDIMENTO', 'CRITICAL', 'INTEGER', 5, 'CONFIG']);
  assert.ok(row.owner_user_id, 'owner obrigatório');
  const tables = await env.adminQuery("SELECT table_name FROM information_schema.tables WHERE table_name ILIKE '%canary%'");
  assert.deepEqual(tables.rows, [], 'não existe tabela paralela de estado');
  const audits = (await env.auditOf(A, 'migration.canary.advanced')).map((r) => [r.after_json.sector, r.before_json.percent, r.after_json.percent]);
  assert.deepEqual(audits.slice(-4), [['ATENDIMENTO', 0, 5], ['ATENDIMENTO', 5, 25], ['ATENDIMENTO', 25, 50], ['ATENDIMENTO', 50, 100]]);
});

test('m9d904 etapa fora da sequência é 422 e a etapa atual de novo devolve sem efeito', { skip: skip() }, async () => {
  await env.addSectorUsers(A, 'ATENDIMENTO', 4);
  await env.setEntities(A, 'ATENDIMENTO', ['QA904_LEAD']);
  for (const percent of [25, 100, 0, 7, '5']) {
    const err = await env.fail(env.advance(A, 'ATENDIMENTO', { percent }));
    assert.deepEqual([err.status, err.code, err.message], [422, 'GOV_CANARY_STEP_INVALID', 'Etapa de ativação inválida.'], String(percent));
  }
  assert.equal(await env.flagRow(A, 'ATENDIMENTO'), null, 'nada foi gravado');
  await env.advance(A, 'ATENDIMENTO', { percent: 5 });
  const version = (await env.flagRow(A, 'ATENDIMENTO')).version;
  const again = await env.advance(A, 'ATENDIMENTO', { percent: 5 });
  assert.equal(again.unchanged, true);
  assert.equal((await env.flagRow(A, 'ATENDIMENTO')).version, version, 'a mesma etapa não gera versão');
  const skipStep = await env.fail(env.advance(A, 'ATENDIMENTO', { percent: 50 }));
  assert.equal(skipStep.code, 'GOV_CANARY_STEP_INVALID');
  const unknown = await env.fail(env.advance(A, 'COZINHA'));
  assert.equal(unknown.status, 404);
});

test('m9d904 avançar com blocker é recusado e o de outra entidade não impede', { skip: skip() }, async () => {
  await env.addSectorUsers(A, 'ATENDIMENTO', 4);
  await env.setEntities(A, 'ATENDIMENTO', ['QA904_LEAD', 'QA904_VISIT']);
  const off = env.openBlocker('QA904_LEAD');
  try {
    const err = await env.fail(env.advance(A, 'ATENDIMENTO'));
    assert.deepEqual([err.status, err.code, err.message], [409, 'GOV_CANARY_BLOCKERS_OPEN', 'Há pendências bloqueantes neste setor.']);
    assert.equal(err.details.count, 1);
    assert.equal(await env.percentOf(A, 'ATENDIMENTO'), 0, 'a flag não se mexeu');
  } finally { off(); }
  const offOther = env.openBlocker('QA904_OUTRA_COISA', 'fora-do-setor');
  try {
    const ok = await env.advance(A, 'ATENDIMENTO');
    assert.equal(ok.percent, 5, 'blocker de entidade fora do setor não impede o avanço');
  } finally { offOther(); }
  const offSector = env.openBlocker('qa904_visit');
  try {
    assert.equal((await env.fail(env.advance(A, 'ATENDIMENTO'))).code, 'GOV_CANARY_BLOCKERS_OPEN', 'a lista de entidades não diferencia maiúsculas');
  } finally { offSector(); }
  assert.equal((await env.advance(A, 'ATENDIMENTO')).percent, 25, 'blocker fechado: o avanço segue');
});

test('m9d904 a lista de entidades do setor é parâmetro: trocar a lista muda o que bloqueia', { skip: skip() }, async () => {
  await env.addSectorUsers(A, 'LOCACAO', 3);
  const off = env.openBlocker('QA904_CONTRATO');
  try {
    await env.setEntities(A, 'LOCACAO', ['QA904_PROPOSTA']);
    assert.equal((await env.advance(A, 'LOCACAO')).percent, 5);
    await env.setEntities(A, 'LOCACAO', ['QA904_PROPOSTA', 'QA904_CONTRATO']);
    assert.equal((await env.fail(env.advance(A, 'LOCACAO'))).code, 'GOV_CANARY_BLOCKERS_OPEN');
  } finally { off(); }
});

test('m9d904 rollback devolve o setor a 0% em um passo, com o motivo registrado', { skip: skip() }, async () => {
  const users = await env.addSectorUsers(A, 'FINANCEIRO', 10);
  await env.setEntities(A, 'FINANCEIRO', ['QA904_LANC']);
  for (let i = 0; i < 3; i += 1) await env.advance(A, 'FINANCEIRO');
  assert.equal(await env.percentOf(A, 'FINANCEIRO'), 50);
  const out = await env.rollback(A, 'FINANCEIRO', { reason: 'Divergência nos lançamentos de teste.' });
  assert.deepEqual([out.previousPercent, out.percent, out.usersInCanary, out.unchanged], [50, 0, 0, false]);
  assert.equal(await env.percentOf(A, 'FINANCEIRO'), 0);
  const [audit] = (await env.auditOf(A, 'migration.canary.rolled_back')).slice(-1);
  assert.deepEqual([audit.before_json.percent, audit.before_json.usersInCanary, audit.after_json.percent, audit.reason], [50, 5, 0, 'Divergência nos lançamentos de teste.']);
  assert.ok(users.length === 10);
  const again = await env.rollback(A, 'FINANCEIRO', { reason: 'de novo' });
  assert.equal(again.unchanged, true, 'setor já em 0% não muda');
  assert.equal((await env.advance(A, 'FINANCEIRO')).percent, 5, 'depois do rollback o setor recomeça da primeira etapa');
});

test('m9d904 rollback sem motivo devolve 422', { skip: skip() }, async () => {
  await env.addSectorUsers(A, 'FINANCEIRO', 3);
  await env.setEntities(A, 'FINANCEIRO', ['QA904_LANC']);
  await env.advance(A, 'FINANCEIRO');
  for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 42 }]) {
    const err = await env.fail(env.rollback(A, 'FINANCEIRO', body));
    assert.deepEqual([err.status, err.code, err.message], [422, 'GOV_CANARY_REASON_REQUIRED', 'Informe o motivo do retorno.']);
  }
  assert.equal(await env.percentOf(A, 'FINANCEIRO'), 5, 'nada mudou');
});

test('m9d904 setores são independentes: flag, etapa e rollback de um não tocam o outro', { skip: skip() }, async () => {
  await env.addSectorUsers(A, 'ATENDIMENTO', 4);
  await env.addSectorUsers(A, 'OBRAS', 4);
  await env.setEntities(A, 'ATENDIMENTO', ['QA904_LEAD']);
  await env.setEntities(A, 'OBRAS', ['QA904_OBRA']);
  await env.advance(A, 'ATENDIMENTO'); await env.advance(A, 'ATENDIMENTO');
  await env.advance(A, 'OBRAS');
  assert.deepEqual([await env.percentOf(A, 'ATENDIMENTO'), await env.percentOf(A, 'OBRAS')], [25, 5]);
  const off = env.openBlocker('QA904_OBRA');
  try {
    assert.equal((await env.fail(env.advance(A, 'OBRAS'))).code, 'GOV_CANARY_BLOCKERS_OPEN');
    assert.equal((await env.advance(A, 'ATENDIMENTO')).percent, 50, 'o blocker de obras não trava o atendimento');
  } finally { off(); }
  await env.rollback(A, 'ATENDIMENTO', { reason: 'ensaio de rollback' });
  assert.deepEqual([await env.percentOf(A, 'ATENDIMENTO'), await env.percentOf(A, 'OBRAS')], [0, 5], 'o rollback do atendimento deixa as obras como estavam');
  const state = await env.status(A);
  const byName = Object.fromEntries(state.sectors.map((s) => [s.sector, s.percent]));
  assert.deepEqual([byName.ATENDIMENTO, byName.OBRAS, byName.JURIDICO], [0, 5, 0]);
  assert.equal(state.sectors.length, 6);
});

test('m9d904 o responsável da flag é o A da atividade SECTOR_ACTIVATION do RACI, quando é uma pessoa', { skip: skip() }, async () => {
  const owner = await env.committedUser(A);
  await env.setRaci(A, 'SECTOR_ACTIVATION', [{ userId: owner.id, raci: 'A' }, { role: 'GESTOR', raci: 'R' }]);
  await env.addSectorUsers(A, 'JURIDICO', 2);
  await env.setEntities(A, 'JURIDICO', ['QA904_PRAZO']);
  await env.advance(A, 'JURIDICO');
  assert.equal((await env.flagRow(A, 'JURIDICO')).owner_user_id, owner.id);
  await env.setRaci(A, 'SECTOR_ACTIVATION', []);
});
