'use strict';

// Marco 9, M9-D256 — PRONTO PARA LAB: sandbox determinístico sem rede externa, página com o estado do portão por provider, relatório de ensaio ligado ao adapter, ativação em
// produção só com suíte verde, parâmetros do portão e Definition of Done (item 14). Roda em banco descartável (COMMITA).
process.env.PORT = process.env.M9D256_LAB_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const env = require('../_helpers/m9d256Env');
const { runFailureDrill } = require('../../../src/features/integrations/contingency/drill/drill.run');
const { RELEASE_SETTINGS_SCHEMA } = require('../../../src/features/integrations/registry/release.settings');
const { readReleaseParams, PADROES } = require('../../../src/features/integrations/registry/release.params');
const { assessProductionReadiness } = require('../../../src/features/integrations/health');
const releaseGate = require('../../../src/features/integrations/registry/releaseGate');

const { sequelize, carregarTenants } = env;
let tenant;
let chamar;
let token;
const MENSAGERIA = 'messaging-sandbox';
const raiz = path.join(__dirname, '..', '..', '..');

before(async () => {
  ({ tenant } = await carregarTenants());
  env.ligarPastas();
  env.secrets.setSecretStoreForTests(env.secrets.createHttpVaultStore({ mode: 'sandbox' }));
  token = env.tokenDe(tenant, ['integration:read', 'integration:manage']);
  chamar = env.chamador();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await env.ativarMfa(tenant);
});
beforeEach(() => env.limparPastas());
after(async () => { env.secrets.setSecretStoreForTests(null); env.desligarPastas(); await env.admin().close(); await sequelize.close(); process.exit(0); });

const liberar = (id) => chamar(token, 'POST', `/admin/integrations/registry/connections/${id}/release`);

/** Bloqueia qualquer conexão de rede que não seja para o próprio computador, durante `fn`. */
async function semRedeExterna(fn) {
  const original = net.Socket.prototype.connect;
  const tentativas = [];
  net.Socket.prototype.connect = function bloqueado(...args) {
    const alvo = args[0] && typeof args[0] === 'object' ? args[0] : { host: args[1], port: args[0] };
    const host = String(alvo.host || 'localhost');
    if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !alvo.path) { tentativas.push(host); throw new Error(`rede externa bloqueada: ${host}`); }
    return original.apply(this, args);
  };
  try { return { resultado: await fn(), tentativas }; } finally { net.Socket.prototype.connect = original; }
}

test('sandbox_nao_precisa_de_conta_real', async () => {
  await env.ativarMfa(tenant);
  await env.desativarAtivas(tenant, MENSAGERIA);
  const { resultado, tentativas } = await semRedeExterna(async () => {
    const relatorios = [];
    for (const alvo of env.contract.listTargets()) relatorios.push(await env.contract.runSuite(alvo));
    const drill = await runFailureDrill({ provider: MENSAGERIA, scenario: 'provider-down', companyId: tenant.companyId, outDir: env.pastas.drill });
    return { relatorios, drill };
  });
  assert.deepEqual(tentativas, [], 'nenhuma conexão para fora do computador');
  assert.ok(resultado.relatorios.length >= 17, 'todos os adapters do catálogo com sandbox têm suíte');
  assert.deepEqual(resultado.relatorios.filter((r) => r.status !== 'PASSED').map((r) => `${r.provider}: ${JSON.stringify(r.errors).slice(0, 200)}`), [], 'a suíte de contrato roda verde só com sandbox');
  assert.equal(resultado.drill.report.passed, true, JSON.stringify(resultado.drill.report.steps.filter((s) => !s.ok)));
  assert.equal(resultado.drill.report.adapterHash, env.hashAtual(MENSAGERIA), 'o relatório do ensaio guarda o hash do adapter ensaiado');
  assert.ok(!/postgres|password|secret/i.test(JSON.stringify(resultado.drill.report)), 'o relatório não leva segredo nem conexão');
  // Trocar para a conta real é só configurar a connection e o segredo: a liberação não pede código novo, só as evidências (com sandbox e o cofre).
  await env.evidenciaCompleta(tenant, MENSAGERIA);
  const c = await env.conexaoDeProducao(tenant, MENSAGERIA);
  assert.equal((await liberar(c.id)).status, 200);
});

test('pronto_para_lab_pagina_mostra_not_released', async () => {
  await env.ativarMfa(tenant);
  await env.desfazerLiberacoes(tenant);
  const antes = await chamar(token, 'GET', '/admin/integrations/registry/release-gate');
  assert.equal(antes.status, 200);
  const { providers, summary } = antes.corpo.data;
  assert.ok(providers.length >= 17, 'todos os fornecedores do catálogo aparecem');
  assert.ok(providers.every((p) => p.releaseState === 'NOT_RELEASED' && p.released === 0), 'honestidade: nenhum fornecedor é declarado em produção sem liberação');
  assert.equal(summary.released, 0);
  assert.equal(summary.providers, providers.length);
  const msg = providers.find((p) => p.providerCode === MENSAGERIA);
  assert.deepEqual([msg.domain, msg.criticality], ['MESSAGING', 'HIGH']);
  // Depois de uma liberação real só aquele fornecedor muda, e o resumo conta as connections liberadas (insumo da autochecagem da M9-D258).
  await env.evidenciaCompleta(tenant, MENSAGERIA);
  const c = await env.conexaoDeProducao(tenant, MENSAGERIA);
  assert.equal((await liberar(c.id)).status, 200);
  const depois = (await chamar(token, 'GET', '/admin/integrations/registry/release-gate')).corpo.data;
  assert.deepEqual(depois.providers.filter((p) => p.releaseState === 'RELEASED').map((p) => p.providerCode), [MENSAGERIA]);
  assert.equal(depois.summary.released, 1);
  assert.equal(depois.connections.find((x) => x.connectionId === c.id).releaseState, 'RELEASED');
  assert.ok(!JSON.stringify(depois).includes('secretRef'), 'a página não expõe referência de segredo');
  assert.equal((await chamar(env.tokenDe(tenant, ['settings:read']), 'GET', '/admin/integrations/registry/release-gate')).status, 403);
  // O mesmo estado por serviço (a página de entrega lê isto).
  const porServico = await env.comTenant(tenant, (t) => releaseGate.listReleaseStates(env.ctxDe(tenant), t));
  assert.equal(porServico.summary.released, 1);
});

test('release_readiness_contract_tests_registrado_pela_d256', async () => {
  await env.ativarMfa(tenant);
  const sem = await env.comTenant(tenant, (t) => assessProductionReadiness(MENSAGERIA, env.ctxDe(tenant), t));
  assert.equal(sem.items.contractTests.ok, false, 'sem relatório SANDBOX a verificação contractTests está vermelha');
  assert.ok(sem.missing.includes('contractTests') && !sem.ready);
  await env.relatorioDeContrato(MENSAGERIA, 'SANDBOX');
  const com = await env.comTenant(tenant, (t) => assessProductionReadiness(MENSAGERIA, env.ctxDe(tenant), t));
  assert.equal(com.items.contractTests.ok, true);
  assert.deepEqual(['healthCheck', 'runbook', 'slo', 'alerts', 'contractTests'].filter((k) => !com.items[k].ok), [], JSON.stringify(com.items));
  // Sem as cinco verdadeiras o portão não preenche production_released_at.
  const c = await env.conexaoDeProducao(tenant, MENSAGERIA);
  env.limparPastas();
  const r = await liberar(c.id);
  assert.equal(r.status, 409);
  assert.ok(r.corpo.error.details.missing.some((m) => m.item === 'contractTests'));
  assert.equal((await env.estadoDe(tenant, c.id)).production_released_at, null);
});

test('release_connection_liberada_so_ativa_em_producao_com_suite_verde', async () => {
  await env.ativarMfa(tenant);
  const c = await env.conexaoDeProducao(tenant, MENSAGERIA);
  await env.evidenciaCompleta(tenant, MENSAGERIA);
  assert.equal((await liberar(c.id)).status, 200);
  // Depois da liberação o adapter muda (relatório de outro hash): ativar em PRODUÇÃO é recusado com o código do relatório (M9-D222).
  env.limparPastas();
  await env.relatorioDeContrato(MENSAGERIA, 'SANDBOX', (rel) => ({ ...rel, adapterHash: 'c'.repeat(64) }));
  await assert.rejects(env.comTenant(tenant, (t) => env.registry.transitionConnection(c.id, 'ACTIVE', env.ctxDe(tenant), t)), (e) => e.statusCode === 409 && e.code === 'INTEGRATION_CONTRACT_REPORT_OUTDATED');
  env.limparPastas();
  await assert.rejects(env.comTenant(tenant, (t) => env.registry.transitionConnection(c.id, 'ACTIVE', env.ctxDe(tenant), t)), (e) => e.code === 'INTEGRATION_CONTRACT_REPORT_MISSING');
  await env.relatorioDeContrato(MENSAGERIA, 'SANDBOX');
  const ativa = await env.comTenant(tenant, (t) => env.registry.transitionConnection(c.id, 'ACTIVE', env.ctxDe(tenant), t));
  assert.equal(ativa.status, 'ACTIVE');
});

test('release_parametros_do_portao_sao_lidos', async () => {
  assert.deepEqual(Object.keys(RELEASE_SETTINGS_SCHEMA).sort(), ['integration.release.drill_scenarios', 'integration.release.no_external_account_providers', 'integration.release.require_rotation_schedule']);
  assert.deepEqual(await env.comTenant(tenant, (t) => readReleaseParams(env.ctxDe(tenant), t)), { requireRotationSchedule: true, drillScenarios: [...PADROES.drillScenarios], noExternalAccountProviders: [...PADROES.noExternalAccountProviders] });
  await env.ativarMfa(tenant);
  await env.evidenciaCompleta(tenant, MENSAGERIA);
  // Sem rotação programada o item "secret" reprova; desligar a exigência (parâmetro) libera.
  const c = await env.conexaoDeProducao(tenant, MENSAGERIA, { semRotacao: true });
  const r = await liberar(c.id);
  assert.deepEqual(env.faltas(r), ['secret']);
  assert.match(JSON.stringify(r.corpo.error.details.missing[0].detail), /rota/i);
  await env.config(tenant, 'integration.release.require_rotation_schedule', false);
  // Cenários exigidos do ensaio de falha vêm do parâmetro: só provider-down passa a bastar.
  await env.config(tenant, 'integration.release.drill_scenarios', 'provider-down');
  env.limparPastas();
  await env.relatorioDeContrato(MENSAGERIA, 'SANDBOX');
  await env.relatorioDeContrato(MENSAGERIA, 'LIVE');
  env.relatorioDeEnsaio(MENSAGERIA, 'provider-down');
  const ok = await liberar(c.id);
  assert.equal(ok.status, 200, JSON.stringify(ok.corpo));
  await env.limparConfig(tenant, ['integration.release.require_rotation_schedule', 'integration.release.drill_scenarios']);
  // Valor inválido do parâmetro é recusado pela tela de parâmetros.
  await assert.rejects(env.config(tenant, 'integration.release.drill_scenarios', 'cenario-inventado'), (e) => e.code === 'SETTING_INVALID_VALUE');
  // Fornecedor de fluxo manual (sem conta externa) não precisa de segredo, webhook nem saída de rede.
  const man = await env.comTenant(tenant, (t) => env.registry.createConnection({ providerCode: 'insurance-manual', environment: 'PRODUCTION', label: `QA-M9 ${env.uniqueSuffix()}` }, env.ctxDe(tenant), t));
  await env.evidenciaCompleta(tenant, 'insurance-manual');
  const m = await liberar(man.id);
  assert.ok(!(env.faltas(m) || []).some((i) => ['secret', 'webhookSecret', 'egress'].includes(i)), JSON.stringify(m.corpo.error));
});

test('release_dod_item_14_tem_a_evidencia', () => {
  assert.ok(fs.existsSync(path.join(raiz, 'src/features/integrations/registry/releaseGate.js')), 'releaseGate.js existe');
  const r = spawnSync(process.execPath, ['scripts/integrationDod.js'], { cwd: raiz, encoding: 'utf8' });
  assert.ok(!/item 14|Homologação específica/i.test(`${r.stdout}${r.stderr}`) || r.status === 0 || !/INTEGRATION_DOD_ITEM_MISSING.*14/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
});
