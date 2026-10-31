'use strict';

// M9-D904 §3.2 — seleção do canary: ordem pelo SHA-256 do id, teto da razão em inteiros, estável entre chamadas e crescente (subir a etapa só acrescenta). Não usa banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { orderByHash, canarySize, selectedUsers, hashOf } = require('../../../src/features/migration-v2/canary/canary.selection');
const { parseStages, parseEntities } = require('../../../src/features/migration-v2/canary/canary.settings');
const { pickTarget } = require('../../../src/features/migration-v2/canary/canary.steps');

const users = Array.from({ length: 20 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);

test('m9d904 seleção do canary é estável por usuário', () => {
  const first = selectedUsers(users, 25);
  for (let i = 0; i < 5; i += 1) assert.deepEqual(selectedUsers([...users].reverse(), 25), first, 'a ordem de entrada não muda a seleção');
  assert.equal(hashOf(users[0]), crypto.createHash('sha256').update(users[0]).digest('hex'));
  const byHash = [...users].sort((a, b) => (hashOf(a) < hashOf(b) ? -1 : 1));
  assert.deepEqual(orderByHash(users), byHash, 'ordem crescente pelo hash do id');
  assert.deepEqual(first, byHash.slice(0, 5));
});

test('m9d904 etapa 25% de 20 usuários seleciona exatamente 5, sempre os mesmos, e 50% mantém os 5', () => {
  const at5 = selectedUsers(users, 5); const at25 = selectedUsers(users, 25); const at50 = selectedUsers(users, 50); const at100 = selectedUsers(users, 100);
  assert.deepEqual([at5.length, at25.length, at50.length, at100.length], [1, 5, 10, 20]);
  assert.ok(at25.every((id) => at50.includes(id)), '50% mantém os 5 de 25%');
  assert.ok(at5.every((id) => at25.includes(id)) && at50.every((id) => at100.includes(id)), 'subir só acrescenta');
  assert.deepEqual(selectedUsers(users, 0), []);
});

test('m9d904 o número de selecionados é o teto de N × percentual / 100, em inteiros', () => {
  assert.deepEqual([[1, 5], [3, 25], [7, 50], [10, 5], [33, 5], [20, 25], [20, 100], [0, 50]].map(([n, p]) => canarySize(n, p)), [1, 1, 4, 1, 2, 5, 20, 0]);
  const ids = Array.from({ length: 7 }, (_, i) => `u${i}`);
  assert.equal(selectedUsers(ids, 50).length, 4);
  assert.equal(selectedUsers([...ids, ...ids], 50).length, 4, 'id repetido conta uma vez');
});

test('m9d904 as etapas do parâmetro: inteiros crescentes de 1 a 100 terminando em 100', () => {
  assert.deepEqual(parseStages('5,25,50,100'), [5, 25, 50, 100]);
  assert.deepEqual(parseStages(' 10 , 100 '), [10, 100]);
  for (const bad of ['', '5,25', '25,5,100', '5,5,100', '0,100', '101', '5,x,100', '5.5,100', null]) assert.equal(parseStages(bad), null, String(bad));
  assert.deepEqual(parseEntities('lead, Visit,lead'), ['LEAD', 'VISIT']);
  for (const bad of ['', ' , ', 'a b', '1x', null]) assert.equal(parseEntities(bad), null, String(bad));
});

test('m9d904 a etapa pedida: a próxima, a atual (sem efeito) ou 422 GOV_CANARY_STEP_INVALID', () => {
  const stages = [5, 25, 50, 100];
  assert.deepEqual(pickTarget(stages, 0, undefined), { target: 5, unchanged: false });
  assert.deepEqual(pickTarget(stages, 5, 25), { target: 25, unchanged: false });
  assert.deepEqual(pickTarget(stages, 25, 25), { target: 25, unchanged: true });
  assert.deepEqual(pickTarget(stages, 10, undefined), { target: 25, unchanged: false }, 'etapa trocada pelo administrador: vale a próxima maior');
  for (const [current, requested] of [[0, 25], [0, 0], [25, 5], [25, 100], [0, '5'], [0, 5.5], [100, undefined], [0, 7]]) {
    assert.throws(() => pickTarget(stages, current, requested), (err) => err.statusCode === 422 && err.code === 'GOV_CANARY_STEP_INVALID' && err.message === 'Etapa de ativação inválida.', `${current} -> ${requested}`);
  }
});
