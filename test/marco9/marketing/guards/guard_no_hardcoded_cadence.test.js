'use strict';

// M9-D440 guard_no_hardcoded_cadence (Guia §14: "Não hard-code cadência"). (1) Estática: nenhum literal de cadência, silêncio, cap ou espera fora de cadence.defaults.js e dos *.settings.js. (2) Dinâmica: alterar o
// parâmetro muda o efeito, sem deploy (M9-D417): o cap e o horário de silêncio mudam a decisão do canSend e a lista de dias muda as datas do plano.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const { withRollbackTenantTransaction } = require('../../../testHelpers');
const { upsertSetting } = require('../../../../src/features/settings/settings.service');
const { canSend } = require('../../../../src/features/marketing/suppression/canSend');
const P = require('../../../../src/features/marketing/automations/cadence');
const { installSeed } = require('../../../../src/features/marketing/automations/seeds');
const env = require('../../_helpers/mktPolicyEnv');
const g = require('../../_helpers/mktGuardas');

const NOME = 'guard_no_hardcoded_cadence';
let A;
before(async () => { ({ a: A } = await env.tenants()); });
after(async () => { await sequelize.close(); });
const run = (fn) => withRollbackTenantTransaction(A, fn);
const send = (t, personId, instant) => canSend(personId, 'WHATSAPP', 'MARKETING', instant, { tenant: A, transaction: t, officialTemplate: true });

test('guard_no_hardcoded_cadence: o código do Marketing não tem literal de cadência, silêncio, cap ou espera fora dos dicionários de parâmetros', () => {
  g.assertSemViolacao(NOME);
});

test('guard_no_hardcoded_cadence: o literal do livro (delay = 3 * 86400) é achado com arquivo e linha', () => {
  const copia = g.copiaDoModulo([{ arquivo: 'src/features/marketing/automations/violacao.js', criar: "'use strict';\n\nconst delay = 3 * 86400;\n" }]);
  try {
    const achados = g.violacoesDe(NOME, copia);
    assert.equal(achados.length, 1);
    assert.deepEqual([achados[0].arquivo, achados[0].linha], ['automations/violacao.js', 3]);
    assert.match(g.formatar(achados[0]), /^MKT_GUARD_VIOLATION Violação de regra arquitetural do Marketing: \[guard_no_hardcoded_cadence\] automations\/violacao\.js:3 /);
  } finally { require('node:fs').rmSync(copia, { recursive: true, force: true }); }
});

test('guard_no_hardcoded_cadence: trocar o frequency cap pelo parâmetro muda a decisão do canSend sem deploy', async () => {
  await run(async (t) => {
    const at = new Date('2026-11-09T17:00:00Z'); // 14:00 em São Paulo
    const person = await env.readyPerson(t, A);
    await env.addMessage(t, A, { personId: person, at: new Date(at.getTime() - 24 * env.HOUR) });
    assert.equal((await send(t, person, at)).allowed, true, 'com o padrão (3 em 7 dias) uma mensagem ainda cabe');
    await upsertSetting(P.FREQUENCY_CAP_KEY, '1 mensagens por 7 dias', A, A.userId, t);
    const decision = await send(t, person, at);
    assert.deepEqual([decision.allowed, decision.reason, decision.limit], [false, 'FREQUENCY_CAP', 1], 'com o cap em 1 a mesma pessoa é barrada');
    assert.equal(decision.nextEligibleAt.toISOString(), '2026-11-15T17:00:00.000Z');
  });
});

test('guard_no_hardcoded_cadence: trocar o horário de silêncio pelo parâmetro muda a decisão do canSend e a cadência muda as datas do plano', async () => {
  await run(async (t) => {
    const at = new Date('2026-11-09T17:00:00Z'); // 14:00 em São Paulo
    const person = await env.readyPerson(t, A);
    assert.equal((await send(t, person, at)).allowed, true);
    await upsertSetting(P.QUIET_HOURS_KEY, '13:00 a 15:00 America/Sao_Paulo', A, A.userId, t);
    const quiet = await send(t, person, at);
    assert.deepEqual([quiet.allowed, quiet.reason], [false, 'QUIET_HOURS']);
    assert.equal(quiet.nextEligibleAt.toISOString(), '2026-11-09T18:00:00.000Z');
    const before = (await P.planCadence(P.POS_KEYS_DAYS_KEY, '2026-11-10', A, t)).map((p) => p.dueDate);
    await upsertSetting(P.POS_KEYS_DAYS_KEY, '3,45,120,365', A, A.userId, t);
    const after = (await P.planCadence(P.POS_KEYS_DAYS_KEY, '2026-11-10', A, t)).map((p) => p.dueDate);
    assert.deepEqual(before, ['2026-11-13', '2026-12-10', '2027-02-08', '2027-11-10']);
    assert.notDeepEqual(after, before);
    assert.equal(after[0], '2026-11-13');
    assert.equal(after[1], '2026-12-25');
  });
});

test('guard_no_hardcoded_cadence: as automações prontas levam o cap do parâmetro da empresa, não um número do código', async () => {
  await run(async (t) => {
    await upsertSetting(P.FREQUENCY_CAP_KEY, '5 mensagens por 10 dias', A, A.userId, t);
    for (const code of ['POS-CHAVES', 'LOCACAO-CADENCIA', 'RESTRICAO-LEMBRETE', 'RESTRICAO-EXPIRACAO', 'REVIEW-REQUEST']) {
      await installSeed({ code, tenant: A, actor: A.userId }, t);
      const [version] = await g.q(t, 'SELECT v.frequency_cap FROM marketing.automation_versions v JOIN marketing.automation_flows f ON f.id = v.flow_id WHERE f.code = :code', { code });
      assert.deepEqual(version.frequency_cap, { max: 5, windowDays: 10, scope: 'PERSON_CHANNEL_PURPOSE' }, `${code}: o cap da versão publicada vem do parâmetro`);
    }
  });
});
