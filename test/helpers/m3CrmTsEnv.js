'use strict';

// Apoio do arquivo dos 15 CRM-TS do livro (test/m3.crmTs.livro.http.test.js): gestor da empresa "Dev" do seed pela rota (token assinado
// com as permissões, como os demais testes de rota do Marco 3), CPF válido, imóvel, consulta pública e os cenários de serviço (cadência,
// reprocesso do Radar, descrição da NAY). Só no cluster descartável.
const assert = require('node:assert/strict');
const { getSeedTenant, uniqueSuffix } = require('../testHelpers');
const { signAccessToken } = require('../../src/utils/jwt');
const { admin } = require('../marco9/_helpers/aiHttpEnv');

const DEV_PERMS = [
  'people:create', 'people:read', 'people:update', 'crm:opportunities:create', 'crm:opportunities:read', 'crm:opportunities:read:all', 'crm:opportunities:update',
  'crm:messages:create', 'crm:messages:read', 'crm:feedback:create', 'crm:feedback:read', 'crm:feedback:update', 'properties:create', 'properties:read',
  'properties:update', 'properties:internal', 'radar:create', 'radar:read',
];

const count = async (sql, params) => Number((await admin(sql, params)).rows[0].n);

/** CPF válido novo (dígitos verificadores calculados). */
function cpf() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const dv = (digits) => { const s = digits.reduce((acc, d, i) => acc + d * (digits.length + 1 - i), 0) % 11; return s < 2 ? 0 : 11 - s; };
  const d1 = dv(base);
  return [...base, d1, dv([...base, d1])].join('');
}

async function devGestor() {
  const tenant = await getSeedTenant();
  const baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  const tokenOf = (permissions) => signAccessToken({ sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'], permissions });
  const caller = (token) => async (method, path, body) => {
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const res = await fetch(path.startsWith('http') ? path : `${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { tenant, baseUrl, call: caller(tokenOf(DEV_PERMS)), as: (permissions) => caller(tokenOf(permissions)), publicCall: caller(null) };
}

const publico = (dev, path) => dev.publicCall('GET', `${dev.baseUrl}${path}`);

function imovel(dev, extra = {}) {
  const s = uniqueSuffix();
  return dev.call('POST', '/properties', { title: `Imóvel CRM-TS ${s}`, internalCode: `TS-${s}`, propertyType: 'RESIDENTIAL', city: 'Campinas', state: 'SP', addressLine: `Rua ${s}`, zipCode: '13010-000', ...extra });
}

async function pessoaDev(dev) {
  const p = await dev.call('POST', '/people', { personType: 'PF', legalName: `Cliente CRM-TS ${uniqueSuffix()}`, allowDuplicate: true });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  return { personId: p.body.data.id };
}

/** CRM-TS-009: a cadência LEAD-SEM-RETORNO de verdade, com o opt-out registrado na pessoa (o mesmo cenário de m3cb.crmTs009.cadencia). */
async function cadenciaComOptOut() {
  require('../../src/features/marketing/suppression');
  const personConsents = require('../../src/features/people/personConsents.service');
  const env = require('../marco9/_helpers/mktLeads');
  const { tenantA: A } = await env.prepararTenants();
  const offVault = env.useTempSecretStore();
  try {
    return await env.withRollbackTenantTransaction(A, async (t) => {
      await env.install(t, A, 'LEAD-SEM-RETORNO');
      const lead = await env.lead(t, A, { source: 'FORM' });
      await env.contact(t, A, lead.personId, new Date('2026-11-01T15:00:00.000Z'), 'OUTBOUND');
      await personConsents.recordConsent(lead.personId, { channel: 'EMAIL', purpose: 'ALL', status: 'OPT_OUT' }, A.userId, t);
      await env.runner.runScheduleTick(A, t, { now: new Date('2026-11-02T12:00:00.000Z'), mode: 'SANDBOX' });
      const enviados = (await env.outbound(t, lead.personId)).filter((m) => m.purpose === 'ACOMPANHAMENTO').length;
      const runs = await env.q(t, 'SELECT blocked_reason FROM marketing.automation_runs WHERE subject_id = :p', { p: lead.personId });
      return { enviados, runs: runs.length, motivos: runs.map((r) => r.blocked_reason) };
    });
  } finally {
    offVault();
  }
}

/** CRM-TS-010: radar e imóvel compatível; o matching roda duas vezes (rede de segurança do job) e conta matches e eventos. */
async function radarReprocessado(dev) {
  const { runRadarMatchingJob } = require('../../src/engines/jobs/radarMatchingJob');
  const cidade = `Cidade ${uniqueSuffix()}`;
  const { personId } = await pessoaDev(dev);
  const radar = await dev.call('POST', '/radar', { personId, criteriaJson: { city: cidade, offerType: 'SALE' } });
  assert.equal(radar.status, 201, JSON.stringify(radar.body));
  const radarId = (radar.body.data.radar || radar.body.data).id;
  const casa = (await imovel(dev, { city: cidade })).body.data;
  assert.equal((await dev.call('POST', `/properties/${casa.id}/offers`, { offerType: 'SALE', askingPrice: 400000 })).status, 201);
  const conta = async () => ({
    matches: await count('SELECT count(*)::int AS n FROM crm.radar_matches WHERE radar_id = $1', [radarId]),
    eventos: await count("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type = 'crm.radar.match.created' AND payload_json->>'radarId' = $1", [radarId]),
  });
  await runRadarMatchingJob();
  const um = await conta();
  await runRadarMatchingJob();
  const dois = await conta();
  return { matchesDepois1: um.matches, matchesDepois2: dois.matches, eventosDepois1: um.eventos, eventosDepois2: dois.eventos };
}

/**
 * CRM-TS-011: a NAY Comercial ATIVA (versão da empresa A criada pelo superusuário do cluster, como em m9d034.http) redige a descrição de um
 * imóvel que só tem cidade e preço no cadastro, pedida pelo corretor em POST /ai/runs. Devolve a resposta e o texto.
 */
async function descricaoSemCampo(env, companyA) {
  const { agenteAtivo } = require('../marco9/_helpers/iaRunApiEnv');
  const gestor = env.tokens['A:gestor'];
  const tenant = { groupId: companyA.group_id, companyId: companyA.id, userId: env.ids.gestor };
  assert.equal((await env.call('PUT', '/settings/ia.habilitada', gestor, { value: true })).status, 200);
  try {
    await agenteAtivo(env, tenant, { code: 'NAY_COMERCIAL', tools: ['crm.getOpportunity', 'crm.getCustomerSummary', 'radar.listMatchesForOpportunity'] });
    const s = uniqueSuffix();
    const casa = await env.call('POST', '/properties', gestor, { title: `Casa sem atributos ${s}`, internalCode: `TS11-${s}`, propertyType: 'RESIDENTIAL', city: 'Curitiba', state: 'PR' });
    assert.equal(casa.status, 201, JSON.stringify(casa.body));
    assert.equal((await env.call('POST', `/properties/${casa.body.data.id}/offers`, gestor, { offerType: 'SALE', askingPrice: 750000 })).status, 201);
    const r = await env.call('POST', '/ai/runs', env.tokens['A:maker'], {
      agentCode: 'NAY_COMERCIAL', purpose: 'Apoio comercial', input: 'Escreva a descrição do imóvel', taskType: 'rascunhar_descricao_imovel', context: { entityType: 'property', entityId: casa.body.data.id },
    });
    return { status: r.status, body: r.body, texto: (r.body && r.body.data && r.body.data.answer) || '' };
  } finally {
    await env.call('PUT', '/settings/ia.habilitada', gestor, { value: false });
  }
}

module.exports = { devGestor, publico, imovel, pessoaDev, cpf, count, cadenciaComOptOut, radarReprocessado, descricaoSemCampo, DEV_PERMS };
