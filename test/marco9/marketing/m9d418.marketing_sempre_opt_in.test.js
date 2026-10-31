'use strict';

// M9-D418 (reabertura M-5) — a finalidade MARKETING exige OPT_IN sempre (MKT-004, LGPD): o administrador não a move para a lista
// sem OPT_IN nem a tira da lista que exige. Banco descartável, role de runtime, rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { canSend } = require('../../../src/features/marketing/suppression/canSend');
const env = require('../_helpers/mktPolicyEnv');

let A;
before(async () => { ({ a: A } = await env.tenants()); });
after(async () => { await sequelize.close(); });
const run = (fn) => withRollbackTenantTransaction(A, fn);
const FOURTEEN = new Date('2026-11-09T17:00:00Z');
const send = (t, personId, purpose) => canSend(personId, 'WHATSAPP', purpose, FOURTEEN, { tenant: A, transaction: t, officialTemplate: true });
const NO_OPT_IN = 'marketing.consent.sem_opt_in_para';
const OPT_IN = 'marketing.consent.exige_opt_in_para';

test('marketing_nunca_entra_na_lista_sem_opt_in', async () => {
  await run(async (t) => {
    for (const value of ['TRANSACTIONAL, MARKETING', 'marketing', 'ACOMPANHAMENTO,  Marketing ,TRANSACTIONAL']) {
      await assert.rejects(upsertSetting(NO_OPT_IN, value, A, A.userId, t), (e) => e.code === 'MKT_PARAM_INVALID' && e.statusCode === 422, value);
    }
    // outra finalidade pode sair da exigência de OPT_IN pelo administrador (só MARKETING é fixa)
    await upsertSetting(NO_OPT_IN, 'TRANSACTIONAL, ACOMPANHAMENTO, LEMBRETE', A, A.userId, t);
    const p = await env.readyPerson(t, A, { optIn: [] });
    assert.equal((await send(t, p, 'LEMBRETE')).allowed, true);
  });
});

test('marketing_continua_exigindo_opt_in_mesmo_fora_da_lista_configurada', async () => {
  await run(async (t) => {
    await upsertSetting(OPT_IN, 'NUTRICAO, RADAR', A, A.userId, t); // administrador esqueceu MARKETING
    const p = await env.readyPerson(t, A, { optIn: [] });
    const r = await send(t, p, 'MARKETING');
    assert.deepEqual([r.allowed, r.reason], [false, 'NO_CONSENT']);
    await env.addConsent(t, A, p, 'WHATSAPP', 'MARKETING', 'OPT_IN');
    assert.equal((await send(t, p, 'MARKETING')).allowed, true);
  });
});
