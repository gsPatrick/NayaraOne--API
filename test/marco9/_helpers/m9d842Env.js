'use strict';

// Apoio do contract test (M9-D842, não é teste): sobe a API real no banco descartável, dá as permissões do contrato ao perfil gestor, tira do perfil maker e faz o login dos atores.
// Rodar SEMPRE em banco descartável (npm run test:contract / scripts/withDisposableDb.js).
const path = require('node:path');
const env = require('./exportsEnv');
const { startHttp } = require('./m9d806Http');
const { listOperations, loadContract } = require('../../../src/features/core-governance/api-governance/contract');

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
  return { http, tokens: { gestor: http.tokens.gestor, maker: http.tokens.maker, gestorB: http.tokens.gestorB }, vars, restore, tenants: http.tenants };
}

/** MFA recente para o ator do exemplo (inserção no cluster descartável, nunca por HTTP). */
const grantMfaFor = (example, tenants) => {
  const tenant = example.as === 'gestorB' ? tenants.B : tenants.A;
  return env.grantMfa(tenant, tenant.userId);
};

/** Tira a verificação recente do ator do exemplo (o MFA habilitado fica). */
const revokeMfaFor = (example, tenants) => env.revokeMfa((example.as === 'gestorB' ? tenants.B : tenants.A).userId);

module.exports = { ...env, startContractApi, grantMfaFor, revokeMfaFor, contractPermissions, loadContract, CONTRACT_FILE, SCOPE_FILE, EXAMPLES_DIR };
