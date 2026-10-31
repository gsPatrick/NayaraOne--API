'use strict';

// Apoio dos testes HTTP da M9-D920 (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js). Sobe a API real, entra com os perfis de CI e envia arquivos.
const crypto = require('node:crypto');
const env = require('./exportsEnv');
const { startHttp } = require('./m9d806Http');
const resolver = require('../../../src/features/core-governance/dlp/classification.resolver');
const classificationWiring = require('../../../src/features/core-governance/data-quality/classification.wiring');
const { pdfBuffer } = require('./m9d920Pdf');

const JUSTIFICATION = 'Contrato pedido pelo cliente para conferência da vigência.';
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/** Sobe a API e entra com gestor e maker da empresa A e o gestor da B. */
const start = (port) => startHttp({ port, grants: {}, logins: { gestorA: ['A', 'gestor'], makerA: ['A', 'maker'], gestorB: ['B', 'gestor'] } });

/** POST /files como a tela faz; devolve a resposta e o id. */
async function upload(http, who, { buffer, fileName = 'contrato.pdf', mimeType = 'application/pdf', category, classification } = {}) {
  const res = await http.call(who, 'POST', '/files', { fileName, mimeType, contentBase64: (buffer || Buffer.from('x')).toString('base64'), ...(category ? { category } : {}), ...(classification ? { classification } : {}) });
  return { ...res, id: res.body && res.body.data ? res.body.data.id : null };
}

/** PDF HIGH enviado por `who` (a classe sai do padrão) e a classe forçada pelo superusuário quando pedida. */
async function uploadPdf(http, who, { classification = null, pages = 1, fileName = 'contrato.pdf' } = {}) {
  const buffer = await pdfBuffer(pages);
  const res = await upload(http, who, { buffer, fileName });
  if (classification) await setClass(res.id, classification);
  return { id: res.id, buffer, sha256: sha(buffer), status: res.status };
}

const setClass = (id, classification) => env.adminQuery('UPDATE people.files SET classification = $2 WHERE id = $1', [id, classification]);
const fileRow = async (id) => (await env.adminQuery('SELECT id, classification, checksum_sha256 FROM people.files WHERE id = $1', [id])).rows[0] || null;
const jobsOf = async (kind) => (await env.adminQuery('SELECT * FROM governance.export_jobs WHERE kind = $1 ORDER BY requested_at', [kind])).rows;

/** Pedido válido de download de HIGH ou RESTRICTED: finalidade e justificativa na query. */
const query = (over = {}) => new URLSearchParams({ purpose: 'CLIENTE_SOLICITOU', justification: JUSTIFICATION, ...over }).toString();

/** GET de um endereço assinado (o caminho que a API devolve começa em /api/v1). */
const raw = (http, who, path) => fetch(`${http.baseUrl}${path.replace(/^\/api\/v1/, '')}`, { headers: { Authorization: `Bearer ${http.tokens[who]}` } });

/** Zera sinais de acesso, anomalias e suspensões (a detecção de acesso em massa da M9-D824 enxerga os lotes grandes). */
const clearSignals = async () => { for (const table of ['access_anomalies', 'user_dlp_state', 'access_signals']) await env.adminQuery(`DELETE FROM governance.${table}`); };

/** Estado limpo entre testes: pedidos, sinais de acesso, MFA e o resolvedor de classe (volta ao do registro de classificação, que a API real usa; não ao stub). */
async function reset() {
  classificationWiring.install();
  // links externos de outros testes do mesmo banco apontam para os pedidos que vão ser apagados (FK)
  await env.adminQuery('DELETE FROM governance.share_links WHERE export_job_id IN (SELECT id FROM governance.export_jobs)');
  await env.cleanExports();
}

const setSetting = (tenant, key, value) => env.adminQuery(
  'INSERT INTO core.tenant_settings (id, group_id, company_id, key, value) VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb) ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value',
  [tenant.groupId, tenant.companyId, key, JSON.stringify(value)]
);
const clearSetting = (tenant, key) => env.adminQuery('DELETE FROM core.tenant_settings WHERE company_id = $1 AND key = $2', [tenant.companyId, key]);

module.exports = { ...env, start, upload, uploadPdf, setClass, fileRow, jobsOf, query, raw, reset, clearSignals, sha, setSetting, clearSetting, JUSTIFICATION, resolver };
