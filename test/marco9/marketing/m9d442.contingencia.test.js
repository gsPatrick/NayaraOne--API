'use strict';

// M9-D442 — credencial recusada ou revogada não espera em fila (WhatsApp tem fila para o canal FORA DO AR, não para conta sem permissão): a mensagem falha de vez, sem nova tentativa.
// O 5xx e o 429 seguem na fila como a M9-D430 manda. Não toca banco: só o plano de contingência e o sandbox.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const adapters = require('../../../src/features/marketing/publications/adapters');

const result = (channel, scenario) => adapters.resetSandbox() || new adapters.SandboxChannelAdapter(channel, { scope: 'qa-m9-d442', slowMs: 1, retryAfterS: 7 })[adapters.CHANNEL_META[channel].operation](
  { to: '+5571999990000', texto: 'Olá' }, { idempotencyKey: `qa-m9-d442-${channel}-${scenario}`, scenario },
);

test('credencial_recusada_no_whatsapp_falha_sem_fila_e_sem_nova_tentativa', async () => {
  adapters.resetSandbox();
  for (const scenario of ['AUTH_REVOKED', 'AUTH_EXPIRED']) {
    const d = adapters.decideOnResult('WHATSAPP', await result('WHATSAPP', scenario));
    assert.deepEqual([d.state, d.retry, d.delivered], ['FAILED', 'NONE', false], scenario);
    assert.notEqual(d.action, 'QUEUE');
  }
  for (const scenario of ['HTTP_5XX', 'HTTP_429']) {
    const d = adapters.decideOnResult('WHATSAPP', await result('WHATSAPP', scenario));
    assert.deepEqual([d.action, d.state], ['QUEUE', 'QUEUED'], `${scenario} continua na fila`);
  }
  adapters.resetSandbox();
});
