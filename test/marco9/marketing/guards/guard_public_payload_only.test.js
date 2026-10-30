'use strict';

// M9-D440 guard_public_payload_only (Guia §14: "Não enviar DTO interno para canal público"). Estática: a porta de saída exige PublicPayload nos canais de publicação e só o sanitizePublicFields marca.
// Dinâmica: o objeto bruto do imóvel (com ocorrência, proprietário e documento) lança 422 MKT_INTERNAL_DTO_FORBIDDEN e nada chega ao adapter; o sanitizado passa; a cópia do sanitizado perde a marca.
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const { withRollbackTenantTransaction } = require('../../../testHelpers');
const { sanitizePublicFields } = require('../../../../src/features/marketing/content/sanitize');
const { sendToChannel } = require('../../../../src/features/marketing/publications/adapters/sendToChannel');
const { adapters } = require('../../../../src/features/marketing/publications');
const { prepararTenants } = require('../../../helpers/marketingExecucao');
const g = require('../../_helpers/mktGuardas');

const NOME = 'guard_public_payload_only';
const DTO = { titulo: 'Casa em Pituba', texto: 'Casa nova.', bairro: 'Pituba', ocorrenciaInterna: 'infiltração no teto', proprietarioCpf: '123.456.789-09', documento: 'matrícula 12345' };
let A;
let espiao;
before(async () => { ({ tenantA: A } = await prepararTenants()); });
beforeEach(() => { adapters.resetSandbox(); espiao = g.espiarCanais(); });
afterEach(() => espiao.restaurar());
after(async () => { await sequelize.close(); });
const enviar = (t, canal, payload) => sendToChannel(canal, payload, { tenant: A, transaction: t, mode: 'SANDBOX', idempotencyKey: `guard-${canal}-${Math.random()}` });

test('guard_public_payload_only: a porta de saída exige PublicPayload e só o sanitizePublicFields marca', () => {
  g.assertSemViolacao(NOME);
});

test('guard_public_payload_only: marcar o payload à mão fora do sanitizador é achado com arquivo e linha', () => {
  const copia = g.copiaDoModulo([{ arquivo: 'src/features/marketing/campaigns/violacao.js', criar: "'use strict';\n\nconst { markPublicPayload } = require('../security/publicPayload');\n\nmodule.exports = (dto) => markPublicPayload(dto);\n" }]);
  try {
    const achados = g.violacoesDe(NOME, copia);
    assert.deepEqual(achados.map((a) => [a.arquivo, a.linha]), [['campaigns/violacao.js', 5]]);
  } finally { require('node:fs').rmSync(copia, { recursive: true, force: true }); }
});

test('guard_public_payload_only: DTO bruto em canal de publicação lança MKT_INTERNAL_DTO_FORBIDDEN e o adapter não é chamado', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    for (const canal of ['SITE', 'INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'YOUTUBE', 'TIKTOK', 'PORTAL']) {
      await assert.rejects(enviar(t, canal, DTO), (e) => e.statusCode === 422 && e.code === 'MKT_INTERNAL_DTO_FORBIDDEN' && /objeto interno/.test(e.message), canal);
    }
    assert.equal(espiao.envios().length, 0, 'nenhuma chamada ao adapter');
  });
});

test('guard_public_payload_only: o payload sanitizado sai; a cópia dele (spread ou JSON) perde a marca e é recusada', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const limpo = sanitizePublicFields(DTO, 'SO_BAIRRO').payload;
    assert.equal('ocorrenciaInterna' in limpo, false);
    assert.equal((await enviar(t, 'SITE', limpo)).ok !== false, true);
    assert.equal(espiao.envios('SITE').length, 1);
    await assert.rejects(enviar(t, 'SITE', { ...limpo }), (e) => e.code === 'MKT_INTERNAL_DTO_FORBIDDEN');
    await assert.rejects(enviar(t, 'SITE', JSON.parse(JSON.stringify(limpo))), (e) => e.code === 'MKT_INTERNAL_DTO_FORBIDDEN');
    assert.equal(espiao.envios('SITE').length, 1, 'as cópias não chegaram ao adapter');
  });
});

test('guard_public_payload_only: mensagem direta a uma pessoa (WhatsApp, e-mail) não é conteúdo público e segue o próprio caminho', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const out = await enviar(t, 'WHATSAPP', { to: '5571999990000', text: 'Olá!' });
    assert.ok(out);
    assert.equal(espiao.envios('WHATSAPP').length, 1);
  });
});
