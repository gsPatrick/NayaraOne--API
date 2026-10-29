'use strict';

// M9-D030 (critério vindo da M9-D020 e da M9-D023) — a busca no índice do RAG ligada ao orquestrador, provada por HTTP real com dois usuários
// de permissões diferentes: o que um não vê o outro vê. O trecho de contrato (legal:read) só chega a quem tem a permissão; o proibido nem
// é lido. Provider sandbox; cluster descartável; nunca chama MFA nem forja token.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP } = require('../_helpers/aiHttpEnv');
const { withTenantTransaction } = require('../../testHelpers');
const H = require('../_helpers/iaRunApiEnv');
const { semear } = require('../_helpers/ragSeed');

let env; let tenant; let code;
const LIVRE = 'Contrato Aurora: política geral de atendimento ao locatário e canais de contato.';
const JURIDICO = 'Contrato Aurora: cláusulas de rescisão e multa contratual de trinta por cento.';

before(async () => {
  if (!DISPOSABLE) return;
  ({ env, tenant } = await H.subir(Number(process.env.M9D030_RAG_TEST_PORT) || 21933));
  await withTenantTransaction(tenant, async (tx) => {
    await semear(tenant, tx, { texto: LIVRE, requiredPermission: 'ai:use', sourceType: 'URL' });
    await semear(tenant, tx, { texto: JURIDICO, requiredPermission: 'legal:read', sourceType: 'URL' });
  });
  code = await H.agenteAtivo(env, tenant, { tools: [], dataScopes: ['urls.contratos'] });
});
after(async () => { await H.encerrar(env, []); });

async function fontesDe(quem) {
  const res = await env.call('POST', '/ai/runs', env.tokens[quem], { agentCode: code, purpose: 'Consulta de contrato', input: 'contrato Aurora política atendimento cláusulas rescisão multa [[RESPOSTA:Há informação sobre o contrato [1].]]' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const lido = await env.call('GET', `/ai/runs/${res.body.data.runId}`, env.tokens['A:gestor']);
  return lido.body.data.sources.map((s) => s.excerpt).join(' | ');
}

test('m9d030_busca_no_indice_com_dois_usuarios_de_permissoes_diferentes', { skip: SKIP }, async () => {
  const semPermissao = await fontesDe('A:maker');
  const comPermissao = await fontesDe('A:checker');
  assert.match(semPermissao, /política geral/, 'quem tem só ai:use vê o trecho livre');
  assert.ok(!/rescisão|multa/.test(semPermissao), 'o trecho de contrato nem chega a quem não tem legal:read');
  assert.match(comPermissao, /política geral/);
  assert.match(comPermissao, /rescisão/, 'quem tem legal:read vê também o trecho de contrato');
  // Quem tem só ai:use e nada do CRM continua sendo atendido; a busca nunca soma permissão.
  const leitura = await env.call('POST', '/ai/runs', env.tokens['A:leitura'], { agentCode: code, purpose: 'Consulta', input: 'contrato Aurora rescisão multa [[RESPOSTA:Sem informação.]]' });
  assert.equal(leitura.status, 200);
  const dela = await env.call('GET', `/ai/runs/${leitura.body.data.runId}`, env.tokens['A:gestor']);
  assert.ok(!dela.body.data.sources.some((s) => /rescisão|multa/.test(s.excerpt || '')));
});
