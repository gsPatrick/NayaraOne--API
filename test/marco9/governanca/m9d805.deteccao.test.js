'use strict';

// M9-D805 — detecção de duplicidade e fila: Person, Property e Supplier. Banco descartável:
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d805.deteccao.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d805Env');
const detection = require('../../../src/features/core-governance/data-quality/merge.detection');
const mergeService = require('../../../src/features/core-governance/data-quality/merge.service');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { adminQuery } = require('../../m9d801.helpers');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;
const run = (fn) => env.withRollbackTenantTransaction(tenants.A, fn);
const detect = (tx, entityTypes) => detection.runDetection(A(), tx, entityTypes ? { entityTypes } : undefined);
const pairOf = (rows, a, b) => rows.find((r) => [r.primary_id, r.secondary_id].sort().join() === [a, b].sort().join());

test('m9d805 CPF igual entra na fila com score 100', { skip: skip() }, async () => {
  await run(async (tx) => {
    const cpf = env.cpf();
    const first = await env.person(A(), tx, { taxIdNormalized: cpf, legalName: 'Zeferino Quintanilha' });
    const second = await env.person(A(), tx, { taxIdNormalized: `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`, legalName: 'Outro Nome Qualquer' });
    const summary = await detect(tx, ['PERSON']);
    assert.ok(summary.inserted >= 1);
    const item = pairOf(await env.queueRows(A(), tx), first.id, second.id);
    assert.ok(item, 'o par entrou na fila');
    assert.deepEqual([item.entity_type, item.kind, item.reason_code, Number(item.score), item.status], ['PERSON', 'MERGE_CANDIDATE', 'PERSON_TAX_ID', 100, 'OPEN']);
    assert.ok(item.primary_id < item.secondary_id, 'par gravado em ordem de id');
  });
});

test('m9d805 nome parecido sem outro dado não entra e as regras de nome entram com os scores do livro', { skip: skip() }, async () => {
  await run(async (tx) => {
    const lonely = await env.person(A(), tx, { legalName: 'Heraclito Albuquerque', birthOrFoundationDate: '1980-01-01' });
    const near = await env.person(A(), tx, { legalName: 'Heraclito Albuquerqui', birthOrFoundationDate: '1999-09-09' });
    const sameBirthA = await env.person(A(), tx, { legalName: 'Teodoro Vasconcelos', birthOrFoundationDate: '1975-05-05' });
    const sameBirthB = await env.person(A(), tx, { legalName: 'Teodoro Vasconcellos', birthOrFoundationDate: '1975-05-05' });
    const tooFar = await env.person(A(), tx, { legalName: 'Teodoro Vasconcelos Junior Neto', birthOrFoundationDate: '1975-05-05' });
    const namedA = await env.person(A(), tx, { legalName: 'Ágatha  Müller-Prado' });
    const namedB = await env.person(A(), tx, { legalName: 'agatha muller prado' });
    await env.contact(A(), tx, namedA.id, '+5511999990001');
    await env.contact(A(), tx, namedB.id, '+5511999990001');
    await detect(tx, ['PERSON']);
    const rows = await env.queueRows(A(), tx);
    assert.equal(pairOf(rows, lonely.id, near.id), undefined, 'distância 2 com nascimento diferente: abaixo de 70, não entra');
    assert.equal(Number(pairOf(rows, sameBirthA.id, sameBirthB.id).score), 70);
    assert.equal(pairOf(rows, sameBirthA.id, tooFar.id), undefined, 'distância acima do limite');
    const named = pairOf(rows, namedA.id, namedB.id);
    assert.deepEqual([named.reason_code, Number(named.score)], ['PERSON_NAME_CONTACT', 85], 'nome normalizado igual e mesmo telefone');
  });
});

test('m9d805 par repetido não duplica a fila', { skip: skip() }, async () => {
  await run(async (tx) => {
    const cpf = env.cpf();
    const a = await env.person(A(), tx, { taxIdNormalized: cpf });
    const b = await env.person(A(), tx, { taxIdNormalized: `${cpf.slice(0, 9)}-${cpf.slice(9)}` });
    await detect(tx, ['PERSON']);
    const again = await detect(tx, ['PERSON']);
    assert.equal(again.inserted, 0);
    const rows = (await env.queueRows(A(), tx)).filter((r) => [a.id, b.id].includes(r.primary_id));
    assert.equal(rows.length, 1);
    const raw = await env.candidate(A(), tx, 'PERSON', b.id, a.id).catch((err) => err);
    assert.equal(raw, null, 'o índice único também recusa o par invertido');
  });
});

test('m9d805 alta confiança não une sozinha', { skip: skip() }, async () => {
  await run(async (tx) => {
    const cpf = env.cpf();
    const a = await env.person(A(), tx, { taxIdNormalized: cpf });
    const b = await env.person(A(), tx, { taxIdNormalized: `${cpf}-` });
    await detect(tx);
    const rows = await env.query('SELECT id, status, merged_into_id FROM people.persons WHERE id IN (:ids)', { ids: [a.id, b.id] }, tx);
    assert.deepEqual(rows.map((r) => [r.status, r.merged_into_id]), [['ACTIVE', null], ['ACTIVE', null]], 'o score 100 só enfileira');
    assert.ok(!(await env.queueRows(A(), tx, "status = 'MERGED' AND primary_id IN (:ids)", { ids: [a.id, b.id] })).length);
  });
});

test('m9d805 detecção para PROPERTY e SUPPLIER entra na fila com os scores 95 e 90', { skip: skip() }, async () => {
  await run(async (tx) => {
    const p1 = await env.property(A(), tx, { registryNumber: 'MAT-QA-0001' });
    const p2 = await env.property(A(), tx, { registryNumber: 'mat qa 0001' });
    const area1 = await env.property(A(), tx, { zipCode: '01310100', addressLine: 'Avenida Paulista', areaTotalM2: 100 });
    const area2 = await env.property(A(), tx, { zipCode: '01310-100', addressLine: 'avenida  paulista', areaTotalM2: 102 });
    const area3 = await env.property(A(), tx, { zipCode: '01310100', addressLine: 'Avenida Paulista', areaTotalM2: 150 });
    const s1 = await env.supplier(A(), tx, { legalName: 'Construtora Alfa Ltda', taxIdNormalized: '12345678000195' });
    const s2 = await env.supplier(A(), tx, { legalName: 'Alfa Filial 2', taxIdNormalized: '12345678000276' });
    const s3 = await env.supplier(A(), tx, { legalName: 'Comercial Beta SA', taxIdNormalized: '99888777000161' });
    const s4 = await env.supplier(A(), tx, { legalName: 'comercial  BETA sa', taxIdNormalized: '55444333000122' });
    const summary = await detect(tx, ['PROPERTY', 'SUPPLIER']);
    assert.ok(summary.byEntity.PROPERTY.inserted >= 2 && summary.byEntity.SUPPLIER.inserted >= 2, JSON.stringify(summary));
    const rows = await env.queueRows(A(), tx);
    const reg = pairOf(rows, p1.id, p2.id);
    assert.deepEqual([reg.entity_type, reg.reason_code, Number(reg.score)], ['PROPERTY', 'PROPERTY_REGISTRY', 95]);
    const area = pairOf(rows, area1.id, area2.id);
    assert.deepEqual([area.reason_code, Number(area.score)], ['PROPERTY_ADDRESS_AREA', 75], 'mesmo endereço e área com diferença abaixo de 3%');
    assert.equal(pairOf(rows, area1.id, area3.id), undefined, 'área 50% maior: não é a mesma');
    const root = pairOf(rows, s1.id, s2.id);
    assert.deepEqual([root.entity_type, root.reason_code, Number(root.score)], ['SUPPLIER', 'SUPPLIER_CNPJ_ROOT', 90]);
    const name = pairOf(rows, s3.id, s4.id);
    assert.deepEqual([name.reason_code, Number(name.score)], ['SUPPLIER_NAME', 80]);
    assert.equal(rows.filter((r) => r.entity_type === 'PERSON' && [s1.id, s2.id].includes(r.primary_id)).length, 0, 'dois fornecedores não aparecem também na fila de pessoas');
  });
});

test('m9d805 maior score prevalece quando várias regras casam', { skip: skip() }, async () => {
  await run(async (tx) => {
    const cpf = env.cpf();
    const a = await env.person(A(), tx, { taxIdNormalized: cpf, legalName: 'Valdemar Pinheiro', birthOrFoundationDate: '1970-02-02' });
    const b = await env.person(A(), tx, { taxIdNormalized: `${cpf}.`, legalName: 'Valdemar Pinheiro', birthOrFoundationDate: '1970-02-02' });
    await env.contact(A(), tx, a.id, 'valdemar@qa-m9.test', 'EMAIL');
    await env.contact(A(), tx, b.id, 'valdemar@qa-m9.test', 'EMAIL');
    await detect(tx, ['PERSON']);
    const mine = (await env.queueRows(A(), tx)).filter((r) => [a.id, b.id].includes(r.primary_id));
    assert.equal(mine.length, 1);
    assert.deepEqual([mine[0].reason_code, Number(mine[0].score)], ['PERSON_TAX_ID', 100], 'CPF (100) vence nome+contato (85) e nome+nascimento (70)');
  });
});

test('m9d805 score mínimo e scores por regra são parâmetros da empresa', { skip: skip() }, async () => {
  await run(async (tx) => {
    const a = await env.person(A(), tx, { legalName: 'Orlando Figueiredo Neto' });
    const b = await env.person(A(), tx, { legalName: 'orlando figueiredo neto' });
    await env.contact(A(), tx, a.id, '+5511988887777');
    await env.contact(A(), tx, b.id, '+5511988887777');
    await upsertSetting('governanca.dados.merge.score_minimo', 90, A(), A().userId, tx);
    await detect(tx, ['PERSON']);
    assert.equal(pairOf(await env.queueRows(A(), tx), a.id, b.id), undefined, '85 < 90: fica de fora');
    await upsertSetting('governanca.dados.merge.scores', 'PERSON_NAME_CONTACT=92', A(), A().userId, tx);
    await detect(tx, ['PERSON']);
    assert.equal(Number(pairOf(await env.queueRows(A(), tx), a.id, b.id).score), 92, 'o score da regra veio do parâmetro');
    const bad = await env.codeOf(upsertSetting('governanca.dados.merge.scores', 'REGRA_INEXISTENTE=50', A(), A().userId, tx));
    assert.equal(bad, 'VALIDATION_ERROR');
  });
});

test('m9d805 detecção nunca compara empresas e a listagem filtra por tipo e status', { skip: skip() }, async () => {
  const cpf = env.cpf();
  const { rows: [foreign] } = await adminQuery(
    `INSERT INTO people.persons (id, group_id, company_id, person_type, legal_name, tax_id_normalized, status) VALUES (gen_random_uuid(), $1, $2, 'PF', 'QA-M9 Pessoa Outra Empresa', $3, 'ACTIVE') RETURNING id`,
    [tenants.B.groupId, tenants.B.companyId, cpf]
  );
  try {
    await run(async (tx) => {
      const mine = await env.person(A(), tx, { taxIdNormalized: cpf });
      await detect(tx, ['PERSON']);
      const rows = await env.queueRows(A(), tx);
      assert.ok(!rows.some((r) => [r.primary_id, r.secondary_id].includes(foreign.id)), 'a pessoa da outra empresa nunca entra no par');
      assert.ok(!rows.some((r) => r.primary_id === mine.id), 'sem par na própria empresa, nada entra');
      const other = await env.person(A(), tx, { taxIdNormalized: `${cpf}-` });
      await detect(tx, ['PERSON']);
      const list = await mergeService.listQueue(A(), { entityType: 'person', status: 'open' }, tx);
      assert.ok(list.items.some((i) => [i.primaryId, i.secondaryId].includes(other.id)));
      assert.ok(list.items.every((i) => i.entityType === 'PERSON' && i.status === 'OPEN'));
      assert.ok(list.items[0].primaryName && list.items[0].secondaryName, 'a lista traz os nomes dos dois cadastros');
      assert.equal((await mergeService.listQueue(A(), { entityType: 'PROPERTY', pageSize: '1' }, tx)).pagination.pageSize, 1);
    });
  } finally {
    await adminQuery('DELETE FROM people.persons WHERE id = $1', [foreign.id]);
  }
});

test('m9d805 distância de nome e diferença de área são parâmetros da empresa', { skip: skip() }, async () => {
  await run(async (tx) => {
    const a = await env.person(A(), tx, { legalName: 'Leocadia Fontenelle', birthOrFoundationDate: '1961-03-03' });
    const b = await env.person(A(), tx, { legalName: 'Leocadia Fontenele', birthOrFoundationDate: '1961-03-03' });
    const p1 = await env.property(A(), tx, { zipCode: '04538133', addressLine: 'Rua Gomes de Carvalho', areaTotalM2: 100 });
    const p2 = await env.property(A(), tx, { zipCode: '04538133', addressLine: 'Rua Gomes de Carvalho', areaTotalM2: 106 });
    await detect(tx, ['PERSON', 'PROPERTY']);
    assert.ok(pairOf(await env.queueRows(A(), tx), a.id, b.id), 'distância 1 com o limite padrão 2');
    assert.equal(pairOf(await env.queueRows(A(), tx), p1.id, p2.id), undefined, '6% de diferença de área, acima dos 3% do padrão');
    await env.query('DELETE FROM governance.review_queue_items WHERE company_id = :c', { c: A().companyId }, tx);
    await upsertSetting('governanca.dados.merge.distancia_nome_max', 0, A(), A().userId, tx);
    await upsertSetting('governanca.dados.merge.area_diferenca_max_pct', 10, A(), A().userId, tx);
    await detect(tx, ['PERSON', 'PROPERTY']);
    assert.equal(pairOf(await env.queueRows(A(), tx), a.id, b.id), undefined, 'distância máxima 0: só nome igual');
    assert.equal(Number(pairOf(await env.queueRows(A(), tx), p1.id, p2.id).score), 75, 'com 10% de tolerância a área de 6% casa');
  });
});

test('m9d805 todo parâmetro declarado é lido pelo código', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const settings = require('../../../src/features/core-governance/data-quality/merge.settings');
  const files = [
    ...fs.readdirSync(path.join(__dirname, '../../../src/features/core-governance/data-quality')).filter((f) => f.startsWith('merge.') && f !== 'merge.settings.js').map((f) => path.join(__dirname, '../../../src/features/core-governance/data-quality', f)),
    path.join(__dirname, '../../../src/engines/jobs/dataQualityMergeDetectionJob.js'),
  ];
  const source = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const constants = Object.entries(settings).filter(([name]) => name.endsWith('_KEY'));
  assert.equal(constants.length, Object.keys(settings.MERGE_SETTINGS_SCHEMA).length, 'uma constante por parâmetro do schema');
  for (const [name, key] of constants) assert.ok(source.includes(`settings.${name}`), `${key} (${name}) é lido por algum arquivo`);
  assert.deepEqual(Object.keys(settings.MERGE_SETTING_DEFAULTS).sort(), Object.keys(settings.MERGE_SETTINGS_SCHEMA).sort());
});
