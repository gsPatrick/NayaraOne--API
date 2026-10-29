'use strict';

// Apoio dos testes M9-D822 (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js). Pedidos e arquivos são gravados de verdade (commit) e limpos no fim.
process.env.DLP_EXPORT_INLINE_DISABLED = process.env.DLP_EXPORT_INLINE_DISABLED || 'true'; // o teste dispara a geração; a rota real (m9d822.http) liga o disparo automático
const fs = require('node:fs');
const zlib = require('node:zlib');
const env = require('./dlpEnv');
const diskStorage = require('../../../src/utils/diskStorage');
const { requestExport } = require('../../../src/features/core-governance/dlp/exports/export.request');
const { generateExport } = require('../../../src/features/core-governance/dlp/exports/export.run');
const { withOwnTenantTransaction } = require('../../../src/features/core-governance/dlp/guard.tx');

/** Lançamentos de teste não se apagam (a tabela é só de acréscimo): cada arquivo de teste usa a sua competência. */
const state = { month: '1999-01' };
const useMonth = (month) => { state.month = month; };
const JUSTIFICATION = 'Fechamento contábil do trimestre, pedido pelo contador.';

/** Pedido válido de exportação financeira da competência de teste (HIGH, justificativa e finalidade presentes). */
const body = (over = {}) => ({
  resourceType: 'finance.entries', filter: { competenceMonth: state.month }, format: 'CSV', purpose: 'CONTABIL', justification: JUSTIFICATION, ...over,
});

const inBusinessTx = (tenant, fn) => withOwnTenantTransaction(tenant, tenant.userId, fn);
let seq = 0;
const nextKey = (label = 'k') => `${label}-${Date.now()}-${(seq += 1)}-abcdefgh`;

/** requestExport como a rota faz: transação da requisição + chave de idempotência (nova por padrão). */
function ask(tenant, over = {}, { key, actorUserId } = {}) {
  return inBusinessTx({ ...tenant, userId: actorUserId || tenant.userId }, (transaction) => requestExport({
    tenant: { groupId: tenant.groupId, companyId: tenant.companyId }, actorUserId: actorUserId || tenant.userId, body: body(over), idempotencyKey: key || nextKey(), transaction,
  }));
}

/** Pede e já gera (MFA recente concedido antes). Devolve o pedido pronto. */
async function askAndGenerate(tenant, over = {}, opts = {}) {
  const out = await ask(tenant, over, opts);
  const job = await generateExport({ groupId: tenant.groupId, companyId: tenant.companyId }, out.exportJobId);
  return { out, job };
}

async function grantMfa(tenant, userId = tenant.userId) {
  await env.adminQuery('DELETE FROM core.mfa_step_ups WHERE user_id = $1', [userId]);
  await env.adminQuery(`INSERT INTO core.mfa_step_ups (id, user_id, group_id, company_id, verified_at, expires_at, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, $3, now(), now() + interval '10 minutes', now(), now())`, [userId, tenant.groupId, tenant.companyId]);
}
const revokeMfa = (userId) => env.adminQuery('DELETE FROM core.mfa_step_ups WHERE user_id = $1', [userId]);

/** Lançamentos de teste na competência do arquivo de teste (inseridos pelo superusuário do cluster descartável). */
async function seedEntries(tenant, count, { description = (i) => `lançamento de teste ${i}` } = {}) {
  for (let i = 0; i < count; i += 1) {
    await env.adminQuery(`INSERT INTO finance.financial_entries (id, group_id, company_id, entry_type, nature, amount, competence_month, description, status, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, 'DEBIT', 'PAYABLE', $3, $4, $5, 'PENDING', now(), now())`, [tenant.groupId, tenant.companyId, 100 + i, state.month, description(i)]);
  }
}

/** Outro usuário da empresa A (perfil maker do seed de CI), para os testes de posse. */
const otherUserId = async () => (await env.adminQuery("SELECT id FROM core.users WHERE email = 'ci-a-maker@ci.nayaraone.test'")).rows[0].id;
const hasRolePermission = async (roleName, code) => (await env.adminQuery(
  'SELECT 1 FROM core.role_permissions rp JOIN core.roles r ON r.id = rp.role_id JOIN core.permissions p ON p.id = rp.permission_id WHERE r.name = $1 AND p.code = $2 LIMIT 1', [roleName, code])).rowCount > 0;

/**
 * Define as permissões dos perfis de CI para o teste ({ 'CI GESTOR': { 'finance:read': true } }) e devolve a função que repõe o que cada perfil tinha ANTES: a
 * semente de CI já concede algumas (legal:read, finance:read), e tirá-las no fim quebraria os testes seguintes do mesmo banco.
 */
async function withRolePermissions(map) {
  const before = [];
  for (const [roleName, codes] of Object.entries(map)) {
    for (const [code, granted] of Object.entries(codes)) {
      before.push([roleName, code, await hasRolePermission(roleName, code)]);
      await env.setRolePermission(roleName, code, granted);
    }
  }
  return async () => { for (const [roleName, code, had] of before.reverse()) await env.setRolePermission(roleName, code, had); };
}

/** CPF válido e único por chamada (a pessoa de teste não pode colidir com a de outro teste do mesmo banco). */
function uniqueCpf() {
  const digits = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  for (let size = 9; size <= 10; size += 1) {
    const sum = digits.reduce((acc, d, i) => acc + d * (size + 1 - i), 0);
    digits.push((sum * 10 % 11) % 10);
  }
  return digits.join('');
}
const jobOf = async (id) => (await env.adminQuery('SELECT * FROM governance.export_jobs WHERE id = $1', [id])).rows[0] || null;
const fileRow = async (id) => (await env.adminQuery('SELECT id, storage_key AS "storageKey", file_name AS "fileName" FROM people.files WHERE id = $1', [id])).rows[0] || null;
const onDisk = (storageKey) => { try { diskStorage.readFile(storageKey); return true; } catch (_e) { return false; } };
const auditOf = async (action, entityId) => (await env.adminQuery('SELECT * FROM audit.audit_log WHERE action = $1 AND entity_id = $2 ORDER BY occurred_at', [action, entityId])).rows;

/** Remove o que os testes criaram: pedidos, arquivos, lançamentos de teste e passos de MFA (os lançamentos e a auditoria são só de acréscimo e ficam; a auditoria é só de acréscimo e fica; os testes a leem pelo id do pedido). */
async function cleanExports() {
  const { rows } = await env.adminQuery("SELECT file_id FROM governance.export_jobs WHERE file_id IS NOT NULL");
  for (const { file_id: fileId } of rows) {
    const file = await fileRow(fileId);
    if (file) { try { diskStorage.deleteFile(file.storageKey); } catch (_e) { /* já apagado */ } }
  }
  // M9-D824: os bloqueios dos testes alimentam a detecção de anomalia; sem limpar, a pessoa de teste ficaria suspensa para os testes seguintes.
  for (const table of ['access_anomalies', 'user_dlp_state', 'access_signals']) await env.adminQuery(`DELETE FROM governance.${table}`).catch(() => null);
  await env.adminQuery('DELETE FROM governance.export_jobs');
  await env.adminQuery("DELETE FROM people.files WHERE storage_key LIKE 'dlp-exports/%'");
  await env.adminQuery("DELETE FROM core.mfa_step_ups WHERE user_id IN (SELECT id FROM core.users WHERE email LIKE 'ci-%@ci.nayaraone.test')");
  await env.cleanDlp();
}

/** Decodifica uma string hexadecimal do PDF: UTF-16BE quando começa por FEFF (dicionário de informações), senão Latin-1 (texto das páginas). */
function pdfHex(hex) {
  const bytes = Buffer.from(hex, 'hex');
  return bytes.slice(0, 2).equals(Buffer.from([0xfe, 0xff])) ? bytes.slice(2).swap16().toString('utf16le') : bytes.toString('latin1');
}

/** Texto de um PDF do pdfkit: o dicionário de informações e os textos dos fluxos (inflados), juntando os pedaços de cada operador TJ/Tj. */
function pdfText(buffer) {
  const raw = buffer.toString('latin1');
  const parts = [raw.replace(/<([0-9a-f]+)>/gi, (_x, hex) => pdfHex(hex))];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content;
    try { content = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch (_e) { continue; }
    for (const op of content.matchAll(/\[([^\]]*)\]\s*TJ|<([0-9a-f]+)>\s*Tj/gi)) {
      const hexes = [...(op[1] || `<${op[2]}>`).matchAll(/<([0-9a-f]+)>/gi)].map((h) => pdfHex(h[1]));
      parts.push(hexes.join(''));
    }
  }
  return parts.join('\n');
}

module.exports = { ...env, withRolePermissions, uniqueCpf, otherUserId, useMonth, state, JUSTIFICATION, body, ask, askAndGenerate, grantMfa, revokeMfa, seedEntries, jobOf, fileRow, onDisk, auditOf, cleanExports, pdfText, nextKey, inBusinessTx, fs };
