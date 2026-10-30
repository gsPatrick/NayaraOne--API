'use strict';

// Apoio dos testes do portão de liberação para produção (M9-D256): connection de PRODUÇÃO com cofre, relatórios de contrato (SANDBOX e LIVE) e de ensaio de falha em pastas
// temporárias, saúde de laboratório e HTTP real com MFA do usuário de teste. Roda em banco descartável (COMMITA). Quem usa define process.env.PORT ANTES de requerer.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('./m9d250Env');
const secrets = require('../../../src/features/integrations/secrets');
const registry = require('../../../src/features/integrations/registry/registry.service');
const contract = require('../../../src/features/integrations/contract');
const { hashAdapter } = require('../../../src/features/integrations/contract/contract.run');
const adapterRegistry = require('../../../src/features/integrations/registry/adapterRegistry');
const health = require('../../../src/features/integrations/health');
const drillReport = require('../../../src/features/integrations/contingency/drill/drill.report');

const { comTenant, ctxDe, sql } = env;
const CENARIOS = ['provider-down', 'rate-limit', 'auth-failed', 'timeout'];
const CONTINGENCIA = { mode: 'QUEUE_QUERY_OR_ALTERNATE_PROVIDER' };

const pastas = { contrato: null, drill: null };
function ligarPastas() {
  pastas.contrato = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d256-contrato-'));
  pastas.drill = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d256-drill-'));
  process.env.INTEGRATION_CONTRACT_REPORT_DIR = pastas.contrato;
  process.env.INTEGRATION_DRILL_REPORT_DIR = pastas.drill;
}
function desligarPastas() {
  [pastas.contrato, pastas.drill].forEach((p) => p && fs.rmSync(p, { recursive: true, force: true }));
  delete process.env.INTEGRATION_CONTRACT_REPORT_DIR;
  delete process.env.INTEGRATION_DRILL_REPORT_DIR;
}
const limparPastas = () => [pastas.contrato, pastas.drill].forEach((p) => fs.readdirSync(p).forEach((f) => fs.rmSync(path.join(p, f), { force: true })));

const hashAtual = (providerCode) => { const i = adapterRegistry.instantiate(providerCode); return hashAdapter(i.constructor, providerCode, i.supportedVersions()); };

/** Relatório de contrato verde do fornecedor (a suíte real roda sobre o sandbox) no modo dado; `mudar` altera o relatório antes de gravar. */
async function relatorioDeContrato(providerCode, modo = 'SANDBOX', mudar = (r) => r) {
  const alvo = contract.listTargets().find((a) => a.providerCode === providerCode);
  const rel = await contract.runSuite(alvo);
  return contract.writeReport(mudar({ ...rel, mode: modo }));
}

/** Relatório de ensaio de falha aprovado de um cenário, do adapter atual (ou do `hash` dado). */
function relatorioDeEnsaio(providerCode, cenario, { hash = hashAtual(providerCode), passed = true } = {}) {
  const r = drillReport.newReport({ provider: providerCode, scenario: cenario, companyId: null, startedAt: new Date() });
  r.adapterHash = hash;
  drillReport.addStep(r, 'contingencia_ativada', passed, null);
  return drillReport.writeReport(drillReport.finish(r, new Date()), pastas.drill);
}
const todosOsEnsaios = (providerCode, opcoes) => CENARIOS.forEach((c) => relatorioDeEnsaio(providerCode, c, opcoes));

/** Conexão de laboratório do fornecedor com a última verificação de saúde dada (verde por padrão). */
async function saudeDeLaboratorio(tenant, providerCode, ok = true) {
  const c = await comTenant(tenant, (t) => registry.createConnection({ providerCode, environment: 'SANDBOX', label: `QA-M9 LAB ${env.uniqueSuffix()}` }, ctxDe(tenant), t));
  await comTenant(tenant, (t) => health.recordHealthCheck(c.id, { ok }, t));
  return c;
}

/** Connection de PRODUÇÃO (rascunho) com segredo no cofre, segredo de webhook, rotação programada e saída permitida. `extra`: policyJson, apiVersion. */
async function conexaoDeProducao(tenant, providerCode, { policyJson, apiVersion, semSegredo = false, semWebhook = false, semRotacao = false, semSaida = false } = {}) {
  const secretRef = semSegredo ? undefined : `company/${tenant.companyId}/release/${env.uniqueSuffix()}`.toLowerCase();
  const policy = { ...(semSaida ? {} : { egressHosts: ['api.exemplo-qa.com.br'] }), ...(policyJson || {}) };
  const c = await comTenant(tenant, (t) => registry.createConnection({ providerCode, environment: 'PRODUCTION', label: `QA-M9 PROD ${env.uniqueSuffix()}`, secretRef, policyJson: policy, apiVersion }, ctxDe(tenant), t));
  if (secretRef) await secrets.getSecretStore().put(secretRef, `chave-${crypto.randomBytes(8).toString('hex')}`, {});
  if (secretRef && !semWebhook) await secrets.getSecretStore().put(secrets.webhookRefOf(secretRef), `wh-${crypto.randomBytes(8).toString('hex')}`, {});
  if (!semRotacao) await sql(tenant, "UPDATE integration.connections SET secret_expires_at = now() + interval '60 days' WHERE id = :id", { id: c.id });
  return c;
}

/** Todas as evidências de um fornecedor de laboratório, menos as que `sem` lista (contractLive, contractTests, failureDrill, healthLab). */
async function evidenciaCompleta(tenant, providerCode, { sem = [] } = {}) {
  if (!sem.includes('contractTests')) await relatorioDeContrato(providerCode, 'SANDBOX');
  if (!sem.includes('contractLive')) await relatorioDeContrato(providerCode, 'LIVE');
  if (!sem.includes('failureDrill')) todosOsEnsaios(providerCode);
  if (!sem.includes('healthLab')) await saudeDeLaboratorio(tenant, providerCode);
}

/** Apaga a última verificação de saúde de laboratório do fornecedor (resto de outros testes do mesmo banco). */
const zerarSaudeDeLaboratorio = (tenant, providerCode) => sql(tenant, 'UPDATE integration.provider_health SET last_check_at = NULL, last_check_ok = NULL WHERE company_id = :c AND provider_code = :p AND window_minutes = 0', { c: tenant.companyId, p: providerCode });

/** Desativa as connections de produção da empresa (volta tudo a NOT_RELEASED): o estado liberado de outros testes do mesmo banco não vaza para a leitura da página. */
const desfazerLiberacoes = (tenant) => sql(tenant, "UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND environment = 'PRODUCTION'", { c: tenant.companyId });

/** Desativa as connections ATIVAS do fornecedor na empresa (o ensaio de falha exige a empresa sem integração ativa dele; testes de outras demandas deixam uma). */
const desativarAtivas = (tenant, providerCode) => sql(tenant, "UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND provider_code = :p AND status = 'ACTIVE'", { c: tenant.companyId, p: providerCode });

const estadoDe = async (tenant, id) => (await sql(tenant, 'SELECT status, production_released_at, production_released_by FROM integration.connections WHERE id = :id', { id }))[0];
const faltas = (r) => (r.corpo.error && r.corpo.error.details && r.corpo.error.details.missing ? r.corpo.error.details.missing.map((m) => m.item) : null);

module.exports = { ...env, CENARIOS, CONTINGENCIA, ligarPastas, desligarPastas, limparPastas, pastas, hashAtual, relatorioDeContrato, relatorioDeEnsaio, todosOsEnsaios, saudeDeLaboratorio, conexaoDeProducao, evidenciaCompleta, estadoDe, desativarAtivas, desfazerLiberacoes, zerarSaudeDeLaboratorio, faltas, secrets, contract, health, registry };
