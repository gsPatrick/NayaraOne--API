'use strict';

// Marco 9, M9-D222 (correção pedida nas reaberturas da M9-D240, D242, D243 e D256): o fornecedor falso do cenário de timeout desiste SEMPRE no prazo, mesmo com a máquina ocupada.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BEFORE } = require('../../../src/features/integrations/contract/contract.wire');

const ocupar = (ms) => { const fim = Date.now() + ms; while (Date.now() < fim) { /* carga */ } };

test('contrato_timeout_sempre_rejeita_com_a_maquina_ocupada', async () => {
  for (let i = 0; i < 25; i += 1) {
    const espera = BEFORE.timeout(5)();
    ocupar(60); // o laço de eventos fica parado além do dobro do prazo: os temporizadores vencem juntos
    await assert.rejects(espera, (e) => e.code === 'ETIMEDOUT' && e.name === 'TimeoutError');
  }
});

test('contrato_timeout_so_rejeita_depois_do_prazo', async () => {
  const t0 = Date.now();
  await assert.rejects(BEFORE.timeout(30)(), { code: 'ETIMEDOUT' });
  assert.ok(Date.now() - t0 >= 25, 'o fornecedor falso não pode responder antes do prazo');
});
