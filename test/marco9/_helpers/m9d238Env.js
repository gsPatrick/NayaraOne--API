'use strict';

const { gravarParametro } = require('../../helpers/mfaRecente'); // parâmetro sensível (requiresMfa): operador com MFA recente real (DI-DEC007-1)

// Apoio dos testes das seguradoras (M9-D238): apólice, escolha do fornecedor (sandbox, fluxo manual), cotação e emissão pelo serviço de Compras, arquivo com hash, eventos
// do outbox e webhook assinado. Roda em banco descartável (os testes COMMITAM). Quem usa define process.env.PORT ANTES de requerer este arquivo (ele sobe o app de teste).
const crypto = require('node:crypto');
const env = require('./m9d212Env');
const settingsService = require('../../../src/features/settings/settings.service');
const insuranceService = require('../../../src/features/procurement/insurance.service');
const { File } = require('../../../src/models');
const { transitionConnection } = require('../../../src/features/integrations/registry/connections.transition');
const { resetSandbox, calls } = require('../../../src/features/integrations/adapters/legacy/insurance.sandbox');

const { comTenant, sql, uniqueSuffix, ctxDe } = env;

const actorDe = (tenant) => ({ userId: tenant.userId, groupId: tenant.groupId, companyId: tenant.companyId });
const config = (tenant, chave, valor) => comTenant(tenant, (t) => gravarParametro(chave, valor, tenant, t));
const escolher = (tenant, provedor) => config(tenant, 'procurement.insurance_provider', provedor);

/** Apólice nova (rascunho). */
const criarApolice = (tenant) => comTenant(tenant, (t) => insuranceService.createPolicy({ groupId: tenant.groupId, companyId: tenant.companyId, coverageSummary: `QA-M9 cobertura ${uniqueSuffix()}` }, tenant.userId, t));
const cotar = (tenant, id, corpo = { estimatedValue: 12000 }) => comTenant(tenant, (t) => insuranceService.quotePolicy(id, corpo, actorDe(tenant), t));
const emitir = (tenant, id, corpo = { effectiveDate: '2026-11-01', expiryDate: '2027-11-01', installmentsCount: 3 }) => comTenant(tenant, (t) => insuranceService.issuePolicy(id, corpo, actorDe(tenant), t));
const apolice = async (tenant, id) => (await sql(tenant, 'SELECT * FROM procurement.insurance_policies WHERE id = :id', { id }))[0];
const parcelas = (tenant, id) => sql(tenant, 'SELECT * FROM procurement.insurance_installments WHERE policy_id = :id ORDER BY due_date', { id });
const tarefaRenovacao = (tenant, id) => sql(tenant, 'SELECT * FROM procurement.insurance_renewal_tasks WHERE policy_id = :id', { id });
const envios = (tenant, id, operation) => sql(tenant, 'SELECT * FROM integration.dispatches WHERE aggregate_id = :id AND (CAST(:op AS text) IS NULL OR operation = :op) ORDER BY created_at, id', { id, op: operation || null });
const eventos = (tenant, id, tipo) => sql(tenant, "SELECT * FROM integration.outbox_events WHERE aggregate_type = 'InsurancePolicy' AND aggregate_id = :id AND (CAST(:t AS text) IS NULL OR event_type = :t) ORDER BY created_at, id", { id, t: tipo || null });
const tarefas = (tenant, id) => sql(tenant, 'SELECT * FROM procurement.insurance_manual_tasks WHERE policy_id = :id ORDER BY created_at, id', { id });
const versoes = (tenant, id) => sql(tenant, 'SELECT * FROM procurement.insurance_policy_versions WHERE policy_id = :id ORDER BY version', { id });

/** Arquivo da empresa (com ou sem o hash gravado). */
function criarArquivo(tenant, { checksum = true, nome } = {}) {
  const conteudo = `conteudo-${uniqueSuffix()}`;
  return comTenant(tenant, (t) => File.create({
    groupId: tenant.groupId, companyId: tenant.companyId, storageKey: `qa-m9/seguro/${uniqueSuffix()}.pdf`, fileName: nome || `apolice-${uniqueSuffix()}.pdf`, mimeType: 'application/pdf', sizeBytes: conteudo.length,
    checksumSha256: checksum ? crypto.createHash('sha256').update(conteudo).digest('hex') : null, scanStatus: 'CLEAN', uploadedByUserId: tenant.userId, createdBy: tenant.userId, updatedBy: tenant.userId,
  }, { transaction: t }));
}

/** Canal ATIVO do fornecedor de seguro da empresa com o segredo do webhook no cofre (outros ativos do mesmo fornecedor ficam pausados). `config`: config_json da connection (ex.: sandbox_fault). */
async function conectar(tenant, providerCode = 'insurance-sandbox', { config: cfg, comSegredo = true } = {}) {
  await sql(tenant, "UPDATE integration.connections SET status = 'PAUSED' WHERE company_id = :c AND provider_code = :p AND status = 'ACTIVE'", { c: tenant.companyId, p: providerCode });
  const canal = await env.criarCanal(tenant, { provider: providerCode, comSegredo });
  if (cfg) await sql(tenant, 'UPDATE integration.connections SET config_json = CAST(:cfg AS jsonb) WHERE id = :id', { id: canal.conn.id, cfg: JSON.stringify(cfg) });
  await comTenant(tenant, (t) => transitionConnection(canal.conn.id, 'ACTIVE', ctxDe(tenant), t));
  return canal;
}

/** Evento de status da apólice no formato do laboratório. */
const eventoStatus = (externalPolicyId, status) => ({ id: `evt-seg-${uniqueSuffix()}`, type: 'policy.status', api_version: 'v1', policy: { id: externalPolicyId }, status });

/** POST do evento: HMAC-SHA256 hexadecimal do corpo bruto no cabeçalho x-webhook-signature. */
function enviarStatus(canal, obj) {
  const corpo = Buffer.from(JSON.stringify(obj));
  return env.postar(`/v1/webhooks/${canal.provider}/${canal.canal}`, corpo, { 'x-webhook-signature': crypto.createHmac('sha256', canal.segredo).update(corpo).digest('hex') });
}

module.exports = {
  ...env, actorDe, config, escolher, criarApolice, cotar, emitir, apolice, parcelas, tarefaRenovacao, envios, eventos, tarefas, versoes, criarArquivo, conectar, eventoStatus, enviarStatus, insuranceService, resetSandbox, calls, settingsService,
};
