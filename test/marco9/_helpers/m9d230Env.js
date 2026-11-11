'use strict';

// Apoio dos testes do WhatsApp (M9-D230): modelos aprovados na connection, consentimento, arquivos de mídia com antivírus e classificação, parâmetros da empresa e leitura de conversas.
// Estende o apoio da mensageria do CRM (M9-D229). Roda em banco descartável (os testes COMMITAM). Quem usa define process.env.PORT ANTES de requerer este arquivo.
const env = require('./m9d229Env');
const dataClassification = require('../../../src/shared/data-classification/scale');
const personConsents = require('../../../src/features/people/personConsents.service');
const filesService = require('../../../src/features/files/files.service');

const { comTenant, sql, uniqueSuffix } = env;

/** Modelo no formato do livro (`config_json.templates[]`). */
const modelo = (name, extra = {}) => ({ name, language: 'pt_BR', category: 'UTILITY', variables: 2, approved: true, approvedAt: '2026-01-01T00:00:00Z', ...extra });

/** Connection de mensageria ativa com os modelos informados (além do padrão). */
const conectarComModelos = (tenant, modelos, provider = 'messaging-sandbox', extra = {}) => env.conectar(tenant, provider, { config: { templates: [...env.MODELOS_PADRAO, ...modelos], ...extra } });

// Parâmetro sensível (requiresMfa, ex.: integration.registry.domain_resolution): gravado por um operador com MFA recente real (DI-DEC007-1).
const parametro = (tenant, chave, valor) => comTenant(tenant, (t) => require('../../helpers/mfaRecente').gravarParametro(chave, valor, tenant, t));
const restaurar = (tenant, chaves) => sql(tenant, 'DELETE FROM core.tenant_settings WHERE company_id = :c AND key IN (:k)', { c: tenant.companyId, k: chaves });

/** Consentimento do WhatsApp: status OPT_IN (concedido) ou OPT_OUT (revogado). */
const consentir = (tenant, personId, status, purpose = 'TRANSACTIONAL') => comTenant(tenant, (t) => personConsents.recordConsent(personId, { channel: 'WHATSAPP', purpose, status }, tenant.userId, t));
const consentimentoAtual = async (tenant, personId, purpose) => (await sql(tenant, "SELECT status FROM people.communication_consents WHERE person_id = :p AND channel = 'WHATSAPP' AND purpose = :u ORDER BY recorded_at DESC LIMIT 1", { p: personId, u: purpose }))[0];

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

/**
 * Arquivo da empresa para anexar como mídia (padrão: PNG limpo e PUBLIC). O conteúdo é gravado de verdade pelo módulo de arquivos, no armazenamento de laboratório (que assina links);
 * antivírus, classificação, tipo e tamanho declarados são ajustados depois, como a verificação e quem classifica fariam. M9-D920: a classificação é obrigatória (escala LOW a RESTRICTED; o vocabulário antigo é convertido) e `classificacao: null` deixa a classe que o upload deu (HIGH).
 */
async function arquivo(tenant, { nome = `foto-${uniqueSuffix()}.png`, mime = 'image/png', bytes = 2048, scan = 'CLEAN', classificacao = 'PUBLIC' } = {}) {
  await parametro(tenant, 'integration.storage.default_provider', 'storage-sandbox');
  const gravado = await comTenant(tenant, (t) => filesService.uploadFile({
    groupId: tenant.groupId, companyId: tenant.companyId, fileName: `foto-${uniqueSuffix()}.png`, mimeType: 'image/png', contentBase64: PNG.toString('base64'), category: 'generic',
  }, tenant.userId, t));
  await sql(tenant, 'UPDATE people.files SET file_name = :n, mime_type = :m, size_bytes = :b, scan_status = :s, classification = COALESCE(:c, classification) WHERE id = :id', { id: gravado.id, n: nome, m: mime, b: bytes, s: scan, c: dataClassification.normalize(classificacao) || null });
  return { id: gravado.id };
}

/** Rodadas do worker de envios até a fila vencida esvaziar: testes anteriores do mesmo banco deixam envios, e cada rodada pega no máximo `worker_batch_size`. */
async function rodarEnvios(tenant) {
  for (let i = 0; i < 25; i += 1) {
    const r = await env.rodarEnvios(tenant);
    if (!r || !r.claimed) return;
  }
}

const authDe = (tenant, extra = {}) => ({ userId: tenant.userId, groupId: tenant.groupId, companyId: tenant.companyId, permissions: [], ...extra });
const contagem = async (tenant, personId) => ({
  mensagens: (await sql(tenant, 'SELECT count(*)::int AS n FROM crm.messages WHERE person_id = :p', { p: personId }))[0].n,
  envios: (await sql(tenant, "SELECT count(*)::int AS n FROM integration.dispatches WHERE company_id = :c AND aggregate_type = 'Message' AND aggregate_id IN (SELECT id FROM crm.messages WHERE person_id = :p)", { c: tenant.companyId, p: personId }))[0].n,
});

module.exports = { ...env, rodarEnvios, modelo, conectarComModelos, parametro, restaurar, consentir, consentimentoAtual, arquivo, authDe, contagem };
