'use strict';

// M9-D416 — duas automações concorrentes para a mesma pessoa não furam o cap: a trava (pessoa, canal, finalidade) e a reserva na
// mesma transação. Conexões separadas com COMMIT real: só em banco descartável (DISPOSABLE_DB=1 e DATABASE_ADMIN_URL).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { canSend } = require('../../../src/features/marketing/suppression/canSend');
const env = require('../_helpers/mktPolicyEnv');
const { DISPOSABLE, SKIP, committedFixture, cleanup, sleep, withTenantTransaction } = require('../_helpers/mktCommit');

let A;
before(async () => { ({ a: A } = await env.tenants()); });
after(async () => { await sequelize.close(); });

const CAP = { max: 1, windowDays: 7, scope: 'PERSON_CHANNEL_PURPOSE' };
const INSTANT = new Date('2026-11-06T15:00:00Z');

test('duas_automacoes_concorrentes_nao_furam_o_cap', { skip: SKIP }, async () => {
  assert.ok(DISPOSABLE);
  const fx = await committedFixture(A, 2);
  try {
    const attempt = (runId, holdMs) => withTenantTransaction(A, async (t) => {
      const decision = await canSend(fx.personId, 'WHATSAPP', 'MARKETING', INSTANT, {
        tenant: A, transaction: t, capDaVersao: CAP, officialTemplate: true, reserve: { runId, actionKey: env.sha(env.uid()) },
      });
      await sleep(holdMs); // segura a trava até o fim da transação: a outra conexão espera e depois relê
      return decision;
    });
    const results = await Promise.all([attempt(fx.runIds[0], 400), attempt(fx.runIds[1], 0)]);
    assert.equal(results.filter((r) => r.allowed).length, 1, JSON.stringify(results));
    const blocked = results.find((r) => !r.allowed);
    assert.equal(blocked.reason, 'FREQUENCY_CAP');
    // dez tentativas em paralelo, cap 1 já ocupado pela reserva: nenhuma passa
    const ten = await Promise.all(Array.from({ length: 10 }, () => attempt(fx.runIds[0], 0)));
    assert.equal(ten.filter((r) => r.allowed).length, 0);
    const reserved = await withTenantTransaction(A, (t) => env.q(t, "SELECT jsonb_array_length(actions_result) AS n FROM marketing.automation_runs WHERE subject_id = :p", { p: fx.personId }));
    assert.equal(reserved.reduce((sum, r) => sum + r.n, 0), 1, 'exatamente uma ação reservada');
  } finally { await cleanup(fx); }
});
