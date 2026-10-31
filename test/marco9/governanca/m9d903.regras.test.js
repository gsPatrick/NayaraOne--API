'use strict';

// M9-D903 — regras de comparação por campo e leitura da janela (sem banco): dinheiro em centavos com tolerância 0, status mapeado, dia civil em São Paulo, tolerância numérica,
// hash sem valor em claro e recusas de configuração. O segredo de hash de PII vem do ambiente do teste.
process.env.PII_HASH_SECRET = process.env.PII_HASH_SECRET || 'm9d903-segredo-de-teste-nao-usar-em-producao';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareField, hashOf } = require('../../../src/features/migration-v2/parallel/compare.rule');
const { parseWindow } = require('../../../src/features/migration-v2/parallel/window.input');
const { parseWindowInstant } = require('../../../src/features/migration-v2/parallel/time.local');

const CTX = { timeZone: 'America/Sao_Paulo' };
const money = (oldUnit, newUnit) => ({ field: 'amount', rule: 'MONEY', tolerance: 0, options: { oldUnit, newUnit } });
const base = { sourceSystem: 'LEGADO_X', entities: ['CONTRACT'], startsAt: '2030-01-01T00:00:00-03:00', endsAt: '2030-01-02T00:00:00-03:00', rules: [] };
const parse = (extra) => parseWindow({ ...base, ...extra }, { timeZone: 'America/Sao_Paulo', defaultInterval: 60 });
const failsWith = (fn, code) => assert.throws(fn, (err) => err.code === code, `esperava ${code}`);

test('m9d903 MONEY compara centavos exatos: R$ 1.250,00 contra R$ 1.250,01 é bloqueante', () => {
  const same = compareField(money('DECIMAL', 'CENTS'), '1250.00', 125000, CTX);
  assert.equal(same.result, 'MATCH');
  const cent = compareField(money('DECIMAL', 'CENTS'), '1250.00', 125001, CTX);
  assert.equal(cent.result, 'DIFF_BLOCKER');
  assert.equal(compareField(money('CENTS', 'CENTS'), 125000, '125000', CTX).result, 'MATCH');
  assert.equal(compareField(money('DECIMAL', 'DECIMAL'), '1250,5', '1250.50', CTX).result, 'MATCH');
  assert.equal(compareField(money('DECIMAL', 'CENTS'), '1250.005', 125001, CTX).result, 'DIFF_BLOCKER', 'centavo fracionado nunca é arredondado');
  assert.equal(compareField(money('CENTS', 'CENTS'), 'abc', 125000, CTX).result, 'DIFF_BLOCKER');
});

test('m9d903 ENUM_MAP: status mapeado é DIFF_ALLOWED, igual é MATCH e fora do mapa é bloqueante', () => {
  const rule = { field: 'status', rule: 'ENUM_MAP', enumMap: { ATIVO: 'ACTIVE' } };
  assert.equal(compareField(rule, 'ATIVO', 'ACTIVE', CTX).result, 'DIFF_ALLOWED');
  assert.equal(compareField(rule, 'ACTIVE', 'ACTIVE', CTX).result, 'MATCH');
  assert.equal(compareField(rule, 'ATIVO', 'CLOSED', CTX).result, 'DIFF_BLOCKER');
  assert.equal(compareField(rule, 'SUSPENSO', 'ACTIVE', CTX).result, 'DIFF_BLOCKER');
});

test('m9d903 EXACT normaliza NFC e espaços; DATE olha o dia civil de São Paulo; NUMERIC usa a tolerância do campo', () => {
  const exact = { field: 'name', rule: 'EXACT' };
  assert.equal(compareField(exact, 'José ', 'José', CTX).result, 'MATCH');
  assert.equal(compareField(exact, 'José', 'Jose', CTX).result, 'DIFF_BLOCKER');
  assert.equal(compareField(exact, '', null, CTX).result, 'MATCH');
  const date = { field: 'due', rule: 'DATE' };
  assert.equal(compareField(date, '2030-05-10', '2030-05-10T02:00:00Z', CTX).result, 'DIFF_BLOCKER', '02:00Z ainda é 09/05 em São Paulo');
  assert.equal(compareField(date, '2030-05-09', '2030-05-10T02:00:00Z', CTX).result, 'MATCH');
  assert.equal(compareField(date, new Date('2030-05-10T15:00:00Z'), '2030-05-10', CTX).result, 'MATCH');
  const numeric = { field: 'area', rule: 'NUMERIC', tolerance: 0 };
  assert.equal(compareField(numeric, '10.50', 10.5, CTX).result, 'MATCH');
  assert.equal(compareField(numeric, '10.50', '10.51', CTX).result, 'DIFF_BLOCKER', 'tolerância padrão é 0');
  assert.equal(compareField({ ...numeric, tolerance: '0.01' }, '10.50', '10.51', CTX).result, 'MATCH');
  assert.equal(compareField({ ...numeric, tolerance: '0.01' }, '10.50', '10.52', CTX).result, 'DIFF_BLOCKER');
  assert.equal(compareField({ field: 'x', rule: 'IGNORE' }, 'a', 'b', CTX), null);
});

test('m9d903 o hash do resultado não contém o valor em claro e separa nulo de texto vazio', () => {
  const h = hashOf('taxId', '12345678909');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.ok(!h.includes('12345678909'));
  assert.notEqual(h, hashOf('taxId', null));
  assert.notEqual(hashOf('taxId', ''), hashOf('taxId', null));
  assert.equal(h, hashOf('taxId', '12345678909'));
  assert.notEqual(h, hashOf('other', '12345678909'));
});

test('m9d903 janela invertida e período inválido recusam com GOV_PARALLEL_WINDOW_INVALID', () => {
  try { parse({ endsAt: base.startsAt }); assert.fail('devia recusar'); } catch (err) {
    assert.equal(err.code, 'GOV_PARALLEL_WINDOW_INVALID');
    assert.equal(err.message, 'O fim da janela deve ser após o início.');
    assert.equal(err.statusCode || err.status, 422);
  }
  failsWith(() => parse({ startsAt: 'ontem' }), 'GOV_PARALLEL_WINDOW_INVALID');
  failsWith(() => parse({ entities: [] }), 'GOV_PARALLEL_WINDOW_INVALID');
  failsWith(() => parse({ intervalMin: 0 }), 'GOV_PARALLEL_WINDOW_INVALID');
  failsWith(() => parse({ sourceSystem: '' }), 'GOV_PARALLEL_WINDOW_INVALID');
});

test('m9d903 intervalo ausente usa o padrão do parâmetro e datas sem deslocamento são lidas em São Paulo', () => {
  const parsed = parse({ startsAt: '2030-01-01T00:00:00', endsAt: '2030-01-02 00:00' });
  assert.equal(parsed.intervalMin, 60);
  assert.equal(parsed.startsAt.toISOString(), '2030-01-01T03:00:00.000Z');
  assert.equal(parsed.endsAt.toISOString(), '2030-01-02T03:00:00.000Z');
  assert.equal(parse({ intervalMin: 15 }).intervalMin, 15);
  assert.equal(parseWindowInstant('2030-01-01T00:00:00Z', 'America/Sao_Paulo').toISOString(), '2030-01-01T00:00:00.000Z');
  assert.equal(parseWindowInstant('2030-01-01T00:00:00', 'UTC').toISOString(), '2030-01-01T00:00:00.000Z');
  assert.equal(parseWindowInstant('2030-02-31', 'UTC'), null);
});

test('m9d903 regras: dinheiro com tolerância é recusado, ENUM_MAP exige mapa e campo duplicado é recusado', () => {
  const rule = (extra) => ({ entity: 'CONTRACT', field: 'amount', rule: 'MONEY', ...extra });
  failsWith(() => parse({ rules: [rule({ tolerance: 0.01 })] }), 'GOV_PARALLEL_RULE_INVALID');
  failsWith(() => parse({ rules: [rule({ rule: 'ENUM_MAP' })] }), 'GOV_PARALLEL_RULE_INVALID');
  failsWith(() => parse({ rules: [rule({ rule: 'EXACT', enumMap: { A: 'B' } })] }), 'GOV_PARALLEL_RULE_INVALID');
  failsWith(() => parse({ rules: [rule({ rule: 'TALVEZ' })] }), 'GOV_PARALLEL_RULE_INVALID');
  failsWith(() => parse({ rules: [rule({ oldUnit: 'REAIS' })] }), 'GOV_PARALLEL_RULE_INVALID');
  failsWith(() => parse({ rules: [rule({ entity: 'PERSON' })] }), 'GOV_PARALLEL_RULE_INVALID');
  failsWith(() => parse({ rules: [rule(), rule({ rule: 'EXACT' })] }), 'GOV_PARALLEL_RULE_INVALID');
  const ok = parse({ rules: [rule({ oldUnit: 'DECIMAL' }), { entity: 'CONTRACT', field: 'area', rule: 'NUMERIC', tolerance: 0.5 }] });
  assert.deepEqual(ok.rules.map((r) => [r.field, r.rule, r.tolerance]), [['amount', 'MONEY', 0], ['area', 'NUMERIC', 0.5]]);
  assert.equal(ok.rules[0].options.oldUnit, 'DECIMAL');
});
