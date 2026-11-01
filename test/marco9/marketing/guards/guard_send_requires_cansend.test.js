'use strict';

// M9-D440 guard_send_requires_cansend (Guia §14: "Não enviar sem consent/suppression check"). Estática: nenhum arquivo chama o canal fora do wrapper (sendMarketingMessage, o "sendThroughPolicy"
// do livro) e o wrapper chama canSend antes do canal. Dinâmica, com espião no adapter sandbox: pessoa sem permissão de contato não chega ao adapter; com permissão chega uma vez.
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const { withRollbackTenantTransaction } = require('../../../testHelpers');
const { suppress } = require('../../../../src/features/marketing/suppression/suppression.service');
const env = require('../../_helpers/mktMsgEnv');
const { useTempSecretStore } = require('../../_helpers/mktSecretStore');
const g = require('../../_helpers/mktGuardas');
const { isolarConexoesDeCanal } = require('../../_helpers/mktConexoesLimpas');

const NOME = 'guard_send_requires_cansend';
let A;
let offVault;
let espiao;
before(async () => { ({ a: A } = await env.tenants()); await isolarConexoesDeCanal(A); offVault = useTempSecretStore(); });
beforeEach(() => { env.adapters.resetSandbox(); espiao = g.espiarCanais(); });
afterEach(() => espiao.restaurar());
after(async () => { offVault(); await sequelize.close(); });

const wa = (personId, over = {}) => ({ channel: 'WHATSAPP', personId, purpose: 'MARKETING', actionKey: env.key(), text: 'Olá! Temos novidades no seu Radar.', ...over });

test('guard_send_requires_cansend: nenhum caminho chama o canal fora do wrapper, e o wrapper consulta o canSend antes', () => {
  g.assertSemViolacao(NOME);
});

test('guard_send_requires_cansend: chamada direta ao canal fora do wrapper é achada com arquivo e linha', () => {
  const copia = g.copiaDoModulo([{ arquivo: 'src/features/marketing/campaigns/violacao.js', criar: "'use strict';\n\nconst { sendToChannel } = require('../publications/adapters/sendToChannel');\n\nmodule.exports = (ctx) => sendToChannel('EMAIL', { to: 'x', text: 'y' }, ctx);\n" }]);
  try {
    const achados = g.violacoesDe(NOME, copia);
    assert.deepEqual(achados.map((a) => [a.arquivo, a.linha]), [['campaigns/violacao.js', 5]]);
    assert.match(achados[0].regra, /fora do wrapper sendMarketingMessage \(sendThroughPolicy\)/);
  } finally { require('node:fs').rmSync(copia, { recursive: true, force: true }); }
});

test('guard_send_requires_cansend: quem pediu para sair, quem está na lista de supressão e quem não deu consentimento nunca chegam ao adapter (espião: zero chamadas)', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const optedOut = await env.readyPerson(t, A);
    const suppressed = await env.readyPerson(t, A);
    const noConsent = await env.readyPerson(t, A, { optIn: [] });
    await env.addConsent(t, A, optedOut, 'WHATSAPP', 'MARKETING', 'OPT_OUT', new Date());
    await suppress({ personId: suppressed, channel: 'WHATSAPP', reason: 'OPT_OUT', source: 'QA-M9' }, A, t);
    for (const [personId, reason] of [[optedOut, 'OPT_OUT'], [suppressed, 'SUPPRESSED'], [noConsent, 'NO_CONSENT']]) {
      const out = await env.send(t, A, wa(personId));
      assert.deepEqual([out.status, out.reason, out.sent], ['BLOCKED', reason, false]);
    }
    assert.equal(espiao.envios().length, 0, 'o adapter não foi chamado nenhuma vez');
    assert.equal(env.adapters.sandboxRecordCount(A.companyId, 'WHATSAPP'), 0);
  });
});

test('guard_send_requires_cansend: quem pode ser contatado chega ao adapter uma vez, e o replay da mesma ação não chama de novo', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const person = await env.readyPerson(t, A);
    await env.openWindow(t, A, person);
    const input = wa(person);
    assert.equal((await env.send(t, A, input)).status, 'SENT');
    assert.equal((await env.send(t, A, input)).status, 'SENT');
    assert.deepEqual(espiao.envios('WHATSAPP').map((c) => c.operacao), ['send'], 'uma única chamada ao adapter');
  });
});
