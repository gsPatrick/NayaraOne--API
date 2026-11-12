'use strict';

// Verificação independente do Marco 9, rodada 6 (DI-M9R-15), varredura dos pontos que gravam texto de fora em jsonb: o webhook assinado chega como corpo
// BRUTO (não passa pela porta de texto da API) e o corpo vai ao jsonb `payload` da caixa de entrada. Com caractere nulo ou metade solta de par sub-rogado, o
// jsonb recusava e a rota pública dava 500 (o fornecedor reenviaria em laço). Agora o evento vai à fila morta com 200, como os demais limites de estrutura
// (M9-D213), sem o corpo; e o alias legado (corpo lido pelo módulo) trata o JSON assim como inválido (corpo vazio, sem efeito).
process.env.PORT = process.env.M9R15_WEBHOOK_TEXTO_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d212Env');
const { tolerantJson } = require('../../../src/features/integrations/webhooks/webhooks.legacy');
const { structureProblem } = require('../../../src/features/integrations/webhooks/intake/intake.structure');

let tenant;
let desligarCofre;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

const LIMITES = { maxDepth: 20, maxKeys: 5000, maxStringLength: 100000 };

test('m9r15 estrutura: texto ou nome de campo com caractere nulo ou metade solta de par sub-rogado é problema de estrutura, sem levar o corpo', () => {
  for (const corpo of [{ nota: 'a\u0000b' }, { nota: 'a\ud800' }, { lista: ['ok', { fundo: '\udc00' }] }, { 'a\u0000': 1 }]) {
    const p = structureProblem(corpo, LIMITES);
    assert.equal(p && p.reason, 'STRUCTURE_LIMIT', JSON.stringify(corpo));
    assert.equal(p.body, null, 'o corpo não segue para o registro do erro (também jsonb)');
  }
  assert.equal(structureProblem({ nota: 'Olá 😀 ação' }, LIMITES), null, 'emoji (par completo) e acento passam');
});

test('m9r15 webhook assinado com caractere nulo ou metade solta: 200 rejected_to_dlq, nunca 500; a fila morta e o erro de integração são gravados', async () => {
  const c = await env.criarCanal(tenant);
  for (const nota of ['a\u0000b', 'a\ud800b']) {
    const r = await env.enviar(c, env.evento({ nota }));
    assert.deepEqual([r.status, r.json], [200, { status: 'rejected_to_dlq' }], JSON.stringify(nota));
  }
  const mortas = await env.sql(tenant, "SELECT status, payload, payload_raw FROM integration.webhook_inbox WHERE connection_id = :id AND dead_letter_reason = 'STRUCTURE_LIMIT'", { id: c.conn.id });
  assert.equal(mortas.length, 2);
  for (const m of mortas) assert.deepEqual([m.status, m.payload, m.payload_raw], ['DEAD_LETTER', null, null]);
  const erros = await env.errosDoCanal(tenant, c, 'INTEGRATION_WEBHOOK_PAYLOAD_INVALID');
  assert.equal(erros.length, 2);
  assert.match(erros[0].message, /caractere que não pode ser gravado/);
  // controle: o mesmo evento sem o caractere é aceito
  const ok = await env.enviar(c, env.evento({ nota: 'Olá 😀' }));
  assert.equal(ok.json.status, 'accepted');
});

test('m9r15 alias legado: JSON com texto que o banco não grava chega ao módulo como corpo vazio (o contrato do JSON inválido)', () => {
  assert.deepEqual(tolerantJson(Buffer.from('{"caso":"a\\u0000b"}')), {});
  assert.deepEqual(tolerantJson(Buffer.from('{"caso":"\\ud800"}')), {});
  assert.deepEqual(tolerantJson(Buffer.from('{"caso":"ok 😀"}')), { caso: 'ok 😀' });
});
