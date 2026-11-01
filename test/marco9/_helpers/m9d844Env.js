'use strict';

// Apoio dos testes M9-D844 (não é teste): credenciais de API externa criadas pelas rotas reais e chamadas /api-external com token de cliente. Rodar SEMPRE em banco descartável.
const env = require('./bcpEnv');
const clientsApi = require('../../../src/features/core-governance/api-governance/clients');
const consumersApi = require('../../../src/features/core-governance/api-governance/consumers');
const { withConfirmation, grantRecentMfa } = require('./m9d852Confirm');

let seq = 0;
const unique = (label) => { seq += 1; return `QA-M9 ${label} ${Date.now()}-${seq}`; };

/** Base de chamada sem usar o login de usuário: `/api/v1` + caminho. */
const baseUrl = () => `http://127.0.0.1:${process.env.PORT}/api/v1`;

/** fetch cru (JSON ou formulário) devolvendo { status, body, headers }. */
async function raw(method, path, { token, body, form, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (form) { init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; init.body = new URLSearchParams(form).toString(); }
  else if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(`${baseUrl()}${path}`, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_e) { json = null; }
  return { status: res.status, body: json, text, headers: res.headers };
}

/** Corpo de criação/revogação com a confirmação nível 3 da M9-D852 (impacto da simulação + código digitado + justificativa) e o MFA recente do gestor no banco descartável. */
async function confirmedBody(http, who, tenant, body) {
  await grantRecentMfa(tenant);
  return withConfirmation(http, who, '/api-governance/clients/impact', body, { method: 'POST', body });
}

/** Revoga pela rota real com MFA recente e confirmação (a simulação de impacto vem do servidor). */
async function revokeClient(http, who, tenant, id) {
  await grantRecentMfa(tenant);
  return http.call(who, 'POST', `/api-governance/clients/${id}/revoke`, await withConfirmation(http, who, `/api-governance/clients/${id}/impact`, {}));
}

/** Cria a credencial pela rota (como o gestor) e devolve { id, clientId, clientSecret, response }. */
async function createClient(http, who, owner, over = {}) {
  const request = { name: unique('credencial'), kind: 'PARTNER', ownerUserId: owner.userId, scopes: ['properties:read'], ...over };
  const response = await http.call(who, 'POST', '/api-governance/clients', await confirmedBody(http, who, owner, request));
  const data = response.body && response.body.data;
  return { response, id: data && data.id, clientId: data && data.clientId, clientSecret: data && data.clientSecret, data };
}

/** POST /api-external/oauth/token (JSON por padrão). */
const tokenFor = (client, over = {}) => raw('POST', '/api-external/oauth/token', { body: { grant_type: 'client_credentials', client_id: client.clientId, client_secret: client.clientSecret, ...over } });

/** Credencial criada + token emitido: { ...client, accessToken, granted }. */
async function clientWithToken(http, who, owner, over = {}, tokenOver = {}) {
  const client = await createClient(http, who, owner, over);
  const issued = await tokenFor(client, tokenOver);
  return { ...client, accessToken: issued.body && issued.body.access_token, issued };
}

/** Apaga o que os testes criaram (credenciais, consumidores externos, uso, leads QA-M9). */
async function cleanClients() {
  await env.adminQuery('DELETE FROM governance.api_clients');
  await env.adminQuery('DELETE FROM governance.api_consumer_usage');
  await env.adminQuery('DELETE FROM governance.api_consumers WHERE app_key IS NULL');
  // Leads de teste: melhor esforço (banco descartável; chaves estrangeiras de eventos podem impedir a limpeza e não atrapalham os testes).
  await env.adminQuery("DELETE FROM crm.opportunities WHERE next_action LIKE '%QA-M9%'").catch(() => {});
  // R5-L1: os parâmetros que os testes gravam não ficam no banco (outros arquivos, como o m9d870.escrita, exigem zero linhas de chave protegida).
  await env.adminQuery("DELETE FROM core.tenant_settings WHERE key IN ('governanca.api.cliente.token_validade_s', 'governanca.api.cliente.segredo_custo', 'governanca.api.externo.lead_prazo_horas')");
  consumersApi.clearContextCache();
  consumersApi.resetUsageThrottle();
}

module.exports = { ...env, unique, raw, createClient, confirmedBody, revokeClient, tokenFor, clientWithToken, cleanClients, clientsApi, consumersApi, baseUrl };
