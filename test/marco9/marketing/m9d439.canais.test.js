'use strict';

// M9-D439 — evidência do DoD por canal: o estado de cada canal vem do parâmetro `marketing.channel.<canal>.liberado` (padrão DESLIGADO). Banco descartável,
// transação com rollback.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const adapters = require('../../../src/features/marketing/publications/adapters');
const { runAsReleaseService } = require('../../../src/features/marketing/publications/adapters/release/releaseScope');
const { upsertSetting, getSetting } = require('../../../src/features/settings/settings.service');

let A;
let B;
before(async () => { ({ tenantA: A, tenantB: B } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

test('estado_do_canal_vem_do_parametro_liberado: os 9 canais nascem em sandbox e a liberação de um não toca os outros nem a outra empresa', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const antes = await adapters.listChannelStatus(A, t);
    assert.deepEqual(antes.map((c) => c.channel), adapters.CHANNELS);
    assert.equal(antes.length, 9);
    for (const c of antes) {
      assert.deepEqual([c.released, c.mode], [false, 'SANDBOX'], c.channel);
      assert.equal(await getSetting(`marketing.channel.${c.channel.toLowerCase()}.liberado`, A, t, 'desligado'), 'desligado');
    }
    await runAsReleaseService(() => upsertSetting('marketing.channel.email.liberado', 'ligado', A, A.userId, t));
    const depois = await adapters.listChannelStatus(A, t);
    assert.deepEqual(depois.filter((c) => c.released).map((c) => c.channel), ['EMAIL']);
    assert.equal(depois.find((c) => c.channel === 'EMAIL').mode, 'PRODUCTION');
    console.log(`# DoD M9-D439, estado dos canais da empresa de teste: ${depois.map((c) => `${c.channel}=${c.released ? 'LIBERADO' : 'DESLIGADO'}`).join(', ')}`);
  });
  await withRollbackTenantTransaction(B, async (t) => {
    assert.equal((await adapters.listChannelStatus(B, t)).filter((c) => c.released).length, 0, 'outra empresa segue toda em sandbox');
  });
});

test('a_alteracao_direta_do_parametro_de_liberacao_e_recusada: so o servico releaseChannel escreve', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await assert.rejects(() => upsertSetting('marketing.channel.whatsapp.liberado', 'ligado', A, A.userId, t), (e) => e.statusCode >= 400 && e.statusCode < 500);
    assert.equal((await adapters.listChannelStatus(A, t)).find((c) => c.channel === 'WHATSAPP').released, false);
  });
});
