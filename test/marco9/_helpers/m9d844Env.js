'use strict';

// Apoio dos testes M9-D844 (não é teste): credenciais de API externa criadas pelas rotas reais e chamadas /api-external com token de cliente. Rodar SEMPRE em banco descartável.
const env = require('./bcpEnv');
const clientsApi = require('../../../src/features/core-governance/api-governance/clients');
const consumersApi = require('../../../src/features/core-governance/api-governance/consumers');

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

/** Cria a credencial pela rota (como o gestor) e devolve { id, clientId, clientSecret, response }. */
async function createClient(http, who, owner, over = {}) {
  const response = await http.call(who, 'POST', '/api-governance/clients', { name: unique('credencial'), kind: 'PARTNER', ownerUserId: owner.userId, scopes: ['properties:read'], ...over });
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
  consumersApi.clearContextCache();
  consumersApi.resetUsageThrottle();
}

module.exports = { ...env, unique, raw, createClient, tokenFor, clientWithToken, cleanClients, clientsApi, consumersApi, baseUrl };
