'use strict';

// Apoio do contract test (M9-D842, não é teste): sobe a API real no banco descartável, dá as permissões do contrato ao perfil gestor, tira do perfil maker e faz o login dos atores.
// Rodar SEMPRE em banco descartável (npm run test:contract / scripts/withDisposableDb.js).
const path = require('node:path');
const env = require('./exportsEnv');
const { startHttp } = require('./m9d806Http');
const { listOperations, loadContract } = require('../../../src/features/core-governance/api-governance/contract');
const { withConfirmation, grantRecentMfa } = require('./m9d852Confirm');

const ROOT = path.resolve(__dirname, '../../..');
// CONTRACT_OPENAPI_FILE troca o contrato lido (evidência da execução vermelha com uma divergência plantada, sem tocar no arquivo versionado).
const CONTRACT_FILE = process.env.CONTRACT_OPENAPI_FILE ? path.resolve(process.env.CONTRACT_OPENAPI_FILE) : path.join(ROOT, 'openapi/openapi.v1.yaml');
const SCOPE_FILE = path.join(ROOT, 'openapi/escopo.json');
const EXAMPLES_DIR = path.join(__dirname, 'contract-examples');

/** Todas as permissões declaradas no contrato (x-permissions). */
const contractPermissions = (doc) => [...new Set(listOperations(doc).flatMap((item) => item.operation['x-permissions'] || []))];

/** Sobe a API; gestor recebe todas as permissões do contrato e maker nenhuma. Devolve { http, tokens, vars, restore }. */
async function startContractApi(doc, port) {
  const permissions = contractPermissions(doc);
  const restore = await env.withRolePermissions({
    'CI GESTOR': Object.fromEntries(permissions.map((code) => [code, true])),
    'CI MAKER': Object.fromEntries(permissions.map((code) => [code, false])),
  });
  const http = await startHttp({ port, grants: {}, logins: { gestor: ['A', 'gestor'], maker: ['A', 'maker'], gestorB: ['B', 'gestor'] } });
  const { A, B } = http.tenants || {};
  const makerId = (await env.adminQuery("SELECT id FROM core.users WHERE email = 'ci-a-maker@ci.nayaraone.test'")).rows[0].id;
  const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
  const vars = { loginEmail: emailFor('A', 'leitura'), loginPassword: process.env.CI_TENANT_USERS_PASSWORD, userId: A.userId, companyId: A.companyId, groupId: A.groupId, makerUserId: makerId, userIdB: B.userId, companyIdB: B.companyId };
  await cleanContractClients(); // credenciais de uma execução anterior neste banco têm o mesmo nome e a criação seria recusada
  const external = await externalClients(http, vars);
  return { http, tokens: { gestor: http.tokens.gestor, maker: http.tokens.maker, gestorB: http.tokens.gestorB, ...external.tokens }, vars: { ...vars, ...external.vars }, restore, tenants: http.tenants };
}

/** Duas credenciais de API externa criadas pela rota (M9-D844): a completa (três scopes) e a limitada (properties:read), com o token de cada uma. */
async function externalClients(http, vars) {
  const issue = async (name, scopes) => {
    // M9-D852 (linha 13): criar credencial é nível 3 com MFA recente; o MFA é gravado no banco descartável e a confirmação vem da simulação de impacto.
    await grantRecentMfa(http.tenants.A);
    const request = { name, kind: 'PARTNER', ownerUserId: vars.userId, scopes };
    const created = await http.call('gestor', 'POST', '/api-governance/clients', await withConfirmation(http, 'gestor', '/api-governance/clients/impact', request, { method: 'POST', body: request }));
    const { clientId, clientSecret } = created.body.data;
    const token = await fetch(`${http.baseUrl}/api-external/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }) });
    return { clientId, clientSecret, accessToken: (await token.json()).access_token };
  };
  const full = await issue('QA-M9 contrato completo', ['properties:read', 'leads:write', 'contracts:read']);
  const limited = await issue('QA-M9 contrato limitado', ['properties:read']);
  return { tokens: { client: full.accessToken, clientLimited: limited.accessToken }, vars: { clientId: full.clientId, clientSecret: full.clientSecret } };
}

/**
 * Remove o que os exemplos positivos do contrato criam e que o próprio contrato recusa repetir (409): credenciais e consumidores externos, o lead externo, o orçamento do ambiente e a
 * política de degradação. Sem isso a segunda execução no mesmo banco falha nesses exemplos (credencial/lead/orçamento já existem).
 */
async function cleanContractClients() {
  await env.adminQuery('DELETE FROM governance.api_clients');
  await env.adminQuery('DELETE FROM governance.api_consumer_usage');
  await env.adminQuery('DELETE FROM governance.api_consumers WHERE app_key IS NULL');
  const lead = "SELECT id FROM people.persons WHERE legal_name = 'QA-M9 Lead do contrato'";
  await env.adminQuery(`DELETE FROM crm.opportunities WHERE person_id IN (${lead})`);
  await env.adminQuery(`DELETE FROM people.person_contacts WHERE person_id IN (${lead})`);
  await env.adminQuery("DELETE FROM people.persons WHERE legal_name = 'QA-M9 Lead do contrato'");
  await env.adminQuery('DELETE FROM governance.budget_alerts');
  await env.adminQuery('DELETE FROM governance.budgets');
  await env.adminQuery('DELETE FROM governance.degradation_policies');
}

/** MFA recente para o ator do exemplo (inserção no cluster descartável, nunca por HTTP). */
const grantMfaFor = (example, tenants) => {
  const tenant = example.as === 'gestorB' ? tenants.B : tenants.A;
  return env.grantMfa(tenant, tenant.userId);
};

/** Tira a verificação recente do ator do exemplo (o MFA habilitado fica). */
const revokeMfaFor = (example, tenants) => env.revokeMfa((example.as === 'gestorB' ? tenants.B : tenants.A).userId);

module.exports = { ...env, startContractApi, cleanContractClients, grantMfaFor, revokeMfaFor, contractPermissions, loadContract, CONTRACT_FILE, SCOPE_FILE, EXAMPLES_DIR };
