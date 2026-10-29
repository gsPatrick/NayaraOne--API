'use strict';

// Marco 9, M9-D243 — provider de modelos de IA no catálogo: aparece no painel com saúde e circuito, não manda dado pessoal sem a
// classificação permitir (D219) e, com a IA fora, o modo determinístico assume (D228). Banco descartável.
process.env.PORT = process.env.M9D243_IA_PORT || '21652';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d249Env');
const { conexaoAtiva, enfileirar, ler, limparPendentes } = require('../_helpers/m9d214Env');
const adapterRegistry = require('../../../src/features/integrations/registry/adapterRegistry');
const { IntegrationAdapter } = require('../../../src/features/integrations/registry/IntegrationAdapter');
const integrations = require('../../../src/features/integrations');
const { resolveConnection } = require('../../../src/features/integrations/registry/connections.resolve');

let tenants;
let token;
let chamar;
before(async () => {
  tenants = await env.carregarTenants();
  token = env.tokenDe(tenants.tenant, ['integration:read']);
  chamar = env.chamador();
  await new Promise((resolve) => setTimeout(resolve, 300));
});
after(async () => { await env.sequelize.close(); process.exit(0); });

test('ia_provider_aparece_no_catalogo_com_saude', async () => {
  const { tenant } = tenants;
  const ia = await env.conexao(tenant, 'AI');
  const analytics = await env.conexao(tenant, 'ANALYTICS');
  assert.equal(ia.providerCode, 'ai-sandbox');
  assert.equal(analytics.providerCode, 'analytics-sandbox');

  const lista = await chamar(token, 'GET', '/admin/integrations?domain=AI');
  const itemIa = lista.corpo.data.items.find((i) => i.id === ia.id);
  assert.equal(itemIa.provider, 'ai-sandbox');
  assert.equal(itemIa.domain, 'AI');
  assert.equal(itemIa.criticality, 'MEDIUM');
  assert.equal(itemIa.circuitState, 'CLOSED');
  assert.ok(['HEALTHY', 'DEGRADED', 'DOWN', 'UNKNOWN'].includes(itemIa.healthStatus));
  const listaAn = await chamar(token, 'GET', '/admin/integrations?domain=ANALYTICS');
  const itemAn = listaAn.corpo.data.items.find((i) => i.id === analytics.id);
  assert.equal(itemAn.criticality, 'LOW');

  const saude = await chamar(token, 'GET', '/admin/integrations/ai-sandbox/health');
  assert.equal(saude.status, 200);
  assert.equal(saude.corpo.data.slo.criticality, 'MEDIUM');

  const catalogo = await chamar(token, 'GET', '/admin/integrations/catalog');
  const dominios = Object.fromEntries(catalogo.corpo.data.domains.map((d) => [d.domain, d]));
  assert.deepEqual(dominios.AI.providers.map((p) => p.code).sort(), ['ai-sandbox', 'anthropic', 'openai']);
  assert.deepEqual(dominios.ANALYTICS.providers.map((p) => p.code), ['analytics-sandbox']);
  assert.equal(dominios.AI.contingencyConfigured, true, 'a IA tem modo de contingência registrado (determinístico)');

  // O adapter do provider de IA estende o contrato único dos adapters (herda saúde, circuito, SLO e redaction).
  const infos = adapterRegistry.list().map((a) => a.providerCode);
  assert.ok(infos.includes('ai-sandbox') && infos.includes('analytics-sandbox'));
  const sandbox = adapterRegistry.has('ai-sandbox');
  assert.equal(sandbox, true);
  assert.ok(integrations.AiAdapter.prototype instanceof IntegrationAdapter);
  assert.ok(integrations.AnalyticsAdapter.prototype instanceof IntegrationAdapter);
});

test('ia_provider_dado_pessoal_bloqueado_por_classificacao', async () => {
  const { tenant } = tenants;
  await conexaoAtiva(tenant, 'AI');
  const recibo = await enfileirar(tenant, {
    domain: 'AI', operation: 'generate', aggregateType: 'Opportunity', aggregateId: '00000000-0000-4000-8000-0000000d0243',
    payload: {
      prompt: 'Resuma a proposta do cliente de CPF 123.456.789-09 e e-mail joao@exemplo.com.br em duas linhas.',
      subjectHash: 'a1b2c3d4', nome: 'Fulano de Tal', renda: 5000, cpf: '123.456.789-09', telefone: '(41) 99999-0000',
    },
  });
  const envio = await ler(tenant, recibo.dispatchId);
  const snap = envio.payload_snapshot;
  assert.deepEqual(Object.keys(snap).sort(), ['prompt', 'subjectHash'], 'só o que a finalidade AI_GENERATION permite');
  assert.ok(!/123\.456\.789-09|joao@exemplo\.com\.br/.test(snap.prompt), 'o texto livre sai sem documento nem e-mail');
  assert.equal(snap.subjectHash, 'a1b2c3d4', 'identificador pseudonimizado passa');
  assert.ok(envio.fields_dropped >= 4, 'nome, renda, CPF e telefone ficam de fora');
  assert.equal(envio.purpose, 'AI_GENERATION');
  await limparPendentes(tenant);
});

test('ia_fora_aciona_modo_deterministico', async () => {
  const { tenant } = tenants;
  const ctx = env.ctxDe(tenant);
  const ia = await conexaoAtiva(tenant, 'AI');
  const busca = {
    semantica: async () => ({ itens: ['resultado-por-significado'] }),
    palavraChave: async () => ({ itens: ['resultado-por-palavra-chave'] }),
  };
  const rodar = () => env.comTenant(tenant, (t) => integrations.withAiFallback(ctx, { ai: busca.semantica, deterministic: busca.palavraChave }, t));

  const normal = await rodar();
  assert.equal(normal.mode, 'NORMAL');
  assert.deepEqual(normal.result.itens, ['resultado-por-significado']);

  // IA fora (circuito aberto): o caminho determinístico responde, com o motivo, sem chamar a IA.
  await env.sql(tenant, `INSERT INTO integration.provider_health (group_id, company_id, connection_id, provider_code, window_start, window_minutes, circuit_state, circuit_opened_at, circuit_cooldown_s)
    VALUES (:g, :c, :id, :p, now(), 0, 'OPEN', now(), 120) ON CONFLICT (connection_id) WHERE window_minutes = 0 DO UPDATE SET circuit_state = 'OPEN', circuit_opened_at = now(), circuit_cooldown_s = 120`,
  { g: tenant.groupId, c: tenant.companyId, id: ia.id, p: ia.providerCode });
  let chamadasIa = 0;
  const fora = await env.comTenant(tenant, (t) => integrations.withAiFallback(ctx, { ai: async () => { chamadasIa += 1; return {}; }, deterministic: busca.palavraChave }, t));
  assert.equal(fora.mode, 'DEGRADE_TO_DETERMINISTIC');
  assert.equal(fora.reason, 'CIRCUIT_OPEN');
  assert.deepEqual(fora.result.itens, ['resultado-por-palavra-chave']);
  assert.equal(chamadasIa, 0);

  // Circuito fechado, mas a IA cai na hora da chamada: cai no determinístico e diz por quê.
  await env.sql(tenant, "UPDATE integration.provider_health SET circuit_state = 'CLOSED', circuit_opened_at = NULL WHERE connection_id = :id AND window_minutes = 0", { id: ia.id });
  const indisponivel = Object.assign(new Error('fora'), { code: 'UNAVAILABLE' });
  const caiu = await env.comTenant(tenant, (t) => integrations.withAiFallback(ctx, { ai: async () => { throw indisponivel; }, deterministic: busca.palavraChave }, t));
  assert.equal(caiu.mode, 'DEGRADE_TO_DETERMINISTIC');
  assert.equal(caiu.reason, 'AI_UNAVAILABLE');
  // Erro de programação não é queda da IA: segue como erro.
  await assert.rejects(env.comTenant(tenant, (t) => integrations.withAiFallback(ctx, { ai: async () => { throw new TypeError('bug'); }, deterministic: busca.palavraChave }, t)), TypeError);

  // Sem connection ativa de IA: o modo determinístico é acionado pelo gancho de contingência da família.
  await env.sql(tenant, "UPDATE integration.connections SET status = 'PAUSED' WHERE company_id = :c AND provider_code = 'ai-sandbox' AND status = 'ACTIVE'", { c: tenant.companyId });
  const antes = integrations.getAiContingencyCount();
  await assert.rejects(env.comTenant(tenant, (t) => resolveConnection({ companyId: tenant.companyId, domain: 'AI' }, t)), (e) => e.code === 'INTEGRATION_CONNECTION_NOT_FOUND');
  assert.equal(integrations.getAiContingencyCount(), antes + 1, 'o gancho de contingência da IA foi acionado');
  const semConexao = await rodar();
  assert.equal(semConexao.mode, 'DEGRADE_TO_DETERMINISTIC');
  assert.equal(semConexao.reason, 'NO_ACTIVE_CONNECTION');
  assert.deepEqual(semConexao.result.itens, ['resultado-por-palavra-chave']);
});
