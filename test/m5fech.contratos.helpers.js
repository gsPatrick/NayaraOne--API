'use strict';

// Apoio dos testes m5fech.contratos.*.test.js (matriz de fechamento do Marco 5, área Contratos).
// HTTP real contra o app (login normal dos usuários fictícios do seed de dois tenants, JWT real,
// tenant e RLS reais). Quem usa define process.env.PORT ANTES de requerer este arquivo. Sem o seed
// ou sem CI_TENANT_USERS_PASSWORD, `pronto()` devolve o motivo e os testes são pulados.
const crypto = require('node:crypto');
const { emailFor } = require('../scripts/seed-ci-two-tenants');
const { sequelize, User } = require('../src/models');

const tokens = {};
const claims = {};
let baseUrl = null;

function tenantOf(quem) {
  const c = claims[quem];
  return { groupId: c.group_id, companyId: c.company_id, userId: c.sub };
}

async function pronto() {
  const password = process.env.CI_TENANT_USERS_PASSWORD;
  if (!password) return 'CI_TENANT_USERS_PASSWORD ausente: rode dentro do banco descartável com o seed de dois tenants.';
  if (!(await User.findOne({ where: { email: emailFor('A', 'maker') } }))) return 'Usuários do seed de dois tenants não encontrados (scripts/seed-ci-two-tenants.js).';
  require('../app');
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((r) => { setTimeout(r, 300); });
  for (const t of ['A', 'B']) {
    for (const perfil of ['maker', 'checker', 'leitura', 'gestor']) {
      let res; let body;
      for (let i = 0; i < 5; i += 1) {
        res = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailFor(t, perfil), password }) });
        body = await res.json();
        if (res.status !== 409) break;
        await new Promise((r) => { setTimeout(r, 200 * (i + 1)); });
      }
      if (res.status !== 200) throw new Error(`login ${t}:${perfil} falhou (${res.status})`);
      const quem = `${t}:${perfil}`;
      tokens[quem] = body.data.accessToken;
      claims[quem] = JSON.parse(Buffer.from(tokens[quem].split('.')[1], 'base64url').toString('utf8'));
    }
  }
  return null;
}

async function http(quem, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (quem) headers.Authorization = `Bearer ${tokens[quem]}`;
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json, code: json && json.error ? json.error.code : null, data: json ? json.data : null };
}

/** Transação no contexto de tenant do perfil (SET LOCAL app.*), com COMMIT ao fim. */
function comTenant(quem, fn) {
  const t = tenantOf(quem);
  return sequelize.transaction(async (tx) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: t.groupId }, transaction: tx });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: t.companyId }, transaction: tx });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: t.userId }, transaction: tx });
    return fn(tx, t);
  });
}

/** SELECT no contexto de tenant do perfil (RLS real). */
async function sql(quem, query, replacements) {
  return comTenant(quem, async (tx) => (await sequelize.query(query, { replacements, transaction: tx }))[0]);
}

const sfx = () => `${Date.now()}${crypto.randomInt(1e5)}`;

async function arquivo(quem, nome = 'contrato.pdf') {
  const r = await http(quem, 'POST', '/files', { fileName: nome, mimeType: 'application/pdf', contentBase64: Buffer.from(`Arquivo fictício ${sfx()}`).toString('base64'), category: 'generic' });
  if (r.status !== 201) throw new Error(`upload falhou: ${r.status} ${JSON.stringify(r.body)}`);
  return r.data.id;
}

async function pessoa(quem, nome) {
  const r = await http(quem, 'POST', '/people', { personType: 'PF', legalName: `${nome} ${sfx()}` });
  if (r.status !== 201) throw new Error(`pessoa falhou: ${r.status} ${JSON.stringify(r.body)}`);
  return r.data.id;
}

/**
 * Contrato de locação levado por HTTP até LEGAL_REVIEW pelo perfil gestor: partes LANDLORD/TENANT, checklist
 * gerado e dispensado com motivo, versão 1 com arquivo. Devolve { contractId, versionId, landlord, tenantPerson, contentHash }.
 */
async function contratoEmRevisao(quem = 'A:gestor') {
  const c = await http(quem, 'POST', '/legal/contracts', { contractType: 'LEASE_RESIDENTIAL', totalValue: 1500 });
  if (c.status !== 201) throw new Error(`contrato falhou: ${c.status}`);
  const contractId = c.data.id;
  const landlord = await pessoa(quem, 'Locador Fictício');
  const tenantPerson = await pessoa(quem, 'Locatário Fictício');
  await http(quem, 'POST', `/legal/contracts/${contractId}/parties`, { personId: landlord, partyRole: 'LANDLORD' });
  await http(quem, 'POST', `/legal/contracts/${contractId}/parties`, { personId: tenantPerson, partyRole: 'TENANT' });
  const reqs = await http(quem, 'POST', `/legal/contracts/${contractId}/requirements/generate`, {});
  for (const r of reqs.data) await http(quem, 'POST', `/legal/requirements/${r.id}/waive`, { reason: 'Dispensa fictícia do teste da matriz M5' });
  const f = await arquivo(quem);
  const v = await http(quem, 'POST', `/legal/contracts/${contractId}/versions`, { content: `Contrato fictício ${sfx()}`, documentFileId: f });
  if (v.status !== 201) throw new Error(`versão falhou: ${v.status} ${JSON.stringify(v.body)}`);
  for (const alvo of ['DOCUMENTS_PENDING', 'LEGAL_REVIEW']) {
    const t = await http(quem, 'POST', `/legal/contracts/${contractId}/transition`, { targetStatus: alvo });
    if (t.status !== 200) throw new Error(`transição ${alvo} falhou: ${t.status} ${JSON.stringify(t.body)}`);
  }
  return { contractId, versionId: v.data.id, contentHash: v.data.contentHash, landlord, tenantPerson, fileId: f };
}

async function eventos(quem, aggregateId, eventType) {
  return sql(quem, 'SELECT event_type, payload_json FROM integration.outbox_events WHERE aggregate_id = :a AND event_type = :e ORDER BY created_at', { a: aggregateId, e: eventType });
}

async function encerrar() {
  await sequelize.close().catch(() => {});
  if (baseUrl) process.exit(0);
}

module.exports = { pronto, http, comTenant, sql, tenantOf, arquivo, pessoa, contratoEmRevisao, eventos, encerrar, sfx };
