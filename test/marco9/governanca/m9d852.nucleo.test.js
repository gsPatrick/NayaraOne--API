'use strict';

// M9-D852 — núcleo sem banco: inventário fechado (19 linhas do livro), níveis por parâmetro, impactToken, corpo de confirmação.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = '../../../src/shared/destructive-actions/';
// Só os módulos puros (sem models nem banco): o teste nunca abre conexão.
const D = { inventory: require(`${R}inventory`), levels: require(`${R}levels`), shape: require(`${R}impact.shape`), token: require(`${R}impact.token`), input: require(`${R}confirmation.input`) };

const BOOK_LEVELS = { 1: 3, 2: 3, 3: 2, 4: 2, 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 3, 11: 3, 12: 2, 13: 3, 15: 3, 16: 3, 17: 3, 18: 2, 19: 2 };

test('m9d852 as 19 ações do inventário têm o nível de confirmação da tabela 3.3', () => {
  const rows = new Map();
  for (const a of D.inventory.all()) {
    if (!rows.has(a.row)) rows.set(a.row, []);
    rows.get(a.row).push(a);
  }
  assert.deepEqual([...rows.keys()].sort((x, y) => x - y), Array.from({ length: 19 }, (_, i) => i + 1), 'as 19 linhas do livro, sem sobra');
  for (const [row, level] of Object.entries(BOOK_LEVELS)) {
    for (const a of rows.get(Number(row))) assert.equal(a.level, level, `linha ${row} (${a.key}) nível ${level}`);
  }
  const kill = rows.get(14);
  assert.deepEqual(kill.map((a) => [a.key, a.level, a.mfa]).sort(), [['kill_switch.activate', 2, 'não'], ['kill_switch.restore', 3, 'sim']]);
  assert.ok(D.inventory.all().every((a) => ['sim', 'não', 'rota'].includes(a.mfa)));
});

test('m9d852 todo item do inventário tem rota, rota de impacto, permissão, código digitável e dona; as sem rota nomeiam a demanda', () => {
  for (const a of D.inventory.all()) {
    assert.match(a.route, /^\/[a-z]/, a.key);
    assert.ok(a.impact && a.impact.path && ['GET', 'POST'].includes(a.impact.method), `${a.key} sem rota de impacto`);
    assert.ok(a.permission && a.codeLabel && a.action, a.key);
    if (!a.wired) assert.match(a.ownerDemand, /^M9-D\d{3}$/, `${a.key} sem demanda dona`);
  }
  assert.deepEqual(D.inventory.unwired().map((a) => a.row).sort((x, y) => x - y), [5, 10, 11, 15, 18]);
});

test('m9d852 níveis efetivos: padrão do livro, sobrescrita pelo parâmetro e valor inválido recusado', () => {
  const def = D.levels.defaultLevelsText();
  for (const a of D.inventory.all()) assert.ok(def.includes(`${a.key}=${a.level}`), a.key);
  assert.equal(D.levels.effectiveLevel('property.delete', def), 2);
  assert.equal(D.levels.effectiveLevel('property.delete', 'property.delete=3'), 3);
  assert.equal(D.levels.effectiveLevel('legal.contract.terminate', 'property.delete=3'), 3, 'chave ausente no texto vale o padrão');
  assert.throws(() => D.levels.validateLevelsText('governanca.ui.confirmacao_por_nivel', 'property.delete=9'));
  assert.throws(() => D.levels.validateLevelsText('governanca.ui.confirmacao_por_nivel', 'nao.existe=2'));
  assert.doesNotThrow(() => D.levels.validateLevelsText('governanca.ui.confirmacao_por_nivel', def));
});

test('m9d852 impactToken: assina, confere e recusa adulteração, outra ação, outro registro, outro usuário e prazo vencido', () => {
  process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'segredo-de-teste-m9d852';
  const impact = D.shape.normalize({ counts: { parcelas: 12 }, totalAmountCents: 1840000, blockers: [] });
  const ctx = { actionKey: 'legal.contract.terminate', resourceId: 'r1', companyId: 'c1', userId: 'u1' };
  const now = 1_000_000_000_000;
  const token = D.token.sign(ctx, impact, { ttlMinutes: 10, now });
  assert.deepEqual(D.token.verify(token, ctx, { now: now + 9 * 60_000 }), { ok: true, impactHash: D.shape.hash(impact) });
  assert.equal(D.token.verify(token, ctx, { now: now + 11 * 60_000 }).reason, 'EXPIRED');
  assert.equal(D.token.verify(token, { ...ctx, resourceId: 'r2' }, { now }).reason, 'BINDING');
  assert.equal(D.token.verify(token, { ...ctx, userId: 'u2' }, { now }).reason, 'BINDING');
  assert.equal(D.token.verify(token, { ...ctx, actionKey: 'property.delete' }, { now }).reason, 'BINDING');
  assert.equal(D.token.verify(`${token}x`, ctx, { now }).reason, 'SIGNATURE');
  assert.equal(D.token.verify('lixo', ctx, { now }).reason, 'MALFORMED');
  const other = D.shape.normalize({ counts: { parcelas: 13 }, totalAmountCents: 1840000, blockers: [] });
  assert.notEqual(D.shape.hash(other), D.shape.hash(impact), 'impacto diferente, hash diferente');
  assert.equal(D.shape.hash(D.shape.normalize({ counts: { b: 1, a: 2 }, totalAmountCents: 0, blockers: [] })), D.shape.hash(D.shape.normalize({ counts: { a: 2, b: 1 }, totalAmountCents: 0, blockers: [] })), 'a ordem das chaves não muda o hash');
});

test('m9d852 nível 2 sem understood e nível 3 sem typedCode, justificativa ou impactToken são recusados', () => {
  const ok = { understood: true, typedCode: 'CT-001', justification: 'Rescisão amigável acordada por e-mail.', impactToken: 'x.y' };
  const check = (level, body, min = 20) => D.input.check({ level, body: { confirmation: body }, expectedCode: 'CT-001', justificationMin: min });
  assert.deepEqual(check(2, { understood: true, impactToken: 'x.y' }), []);
  assert.deepEqual(check(2, { impactToken: 'x.y' }), ['understood']);
  assert.deepEqual(check(2, { understood: 'true', impactToken: 'x.y' }), ['understood'], 'só o booleano true vale');
  assert.deepEqual(check(2, { understood: true }), ['impactToken']);
  assert.deepEqual(check(3, ok), []);
  assert.deepEqual(check(3, { ...ok, typedCode: undefined }), ['typedCode']);
  assert.deepEqual(check(3, { ...ok, typedCode: 'ct-001' }), ['typedCode'], 'o código digitado confere exatamente');
  assert.deepEqual(check(3, { ...ok, justification: 'curta' }), ['justification']);
  assert.deepEqual(check(3, { ...ok, impactToken: '' }), ['impactToken']);
  assert.deepEqual(check(3, {}).sort(), ['impactToken', 'justification', 'typedCode']);
  assert.deepEqual(D.input.check({ level: 3, body: {}, expectedCode: 'CT-001', justificationMin: 20 }).sort(), ['impactToken', 'justification', 'typedCode'], 'sem o objeto confirmation');
  assert.deepEqual(check(1, undefined), [], 'nível 1 não exige corpo');
  assert.deepEqual(check(3, { ...ok, typedCode: '  CT-001 ' }), [], 'espaços nas pontas não contam');
});
