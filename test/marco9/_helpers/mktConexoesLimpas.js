'use strict';

// Isolamento do estado de conexões de canal para os testes de Marketing que mandam mensagem/publicam pelo sandbox da família. O framework de Integrações trata connection
// PAUSED/AUTH_FAILED do fornecedor de laboratório como "parada de propósito" e recusa criar a de laboratório (MKT_CHANNEL_CONNECTION_INACTIVE). Outros arquivos no mesmo banco
// podem deixar uma assim para a empresa; aqui ela sai de cena (DISABLED, igual ao `semSite` da M9-D259) antes do teste, sem tocar nas ACTIVE nem nas de outros fornecedores.
const { sequelize, withTenantTransaction } = require('../../testHelpers');

const SANDBOXES = ['messaging-sandbox', 'email-sandbox', 'site-sandbox', 'social-sandbox'];

async function isolarConexoesDeCanal(tenant) {
  await withTenantTransaction(tenant, (transaction) => sequelize.query(
    "UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND provider_code IN (:p) AND status IN ('PAUSED', 'AUTH_FAILED')",
    { replacements: { c: tenant.companyId, p: SANDBOXES }, transaction },
  ));
}

/**
 * Garante, em série e com commit, a connection ATIVA de laboratório do canal antes de um teste que dispara envios em paralelo. Sem ela, a primeira rodada concorrente cria/ativa a
 * connection ao mesmo tempo (e quando já há um rascunho do fornecedor, dois pedidos tentam ativar o mesmo rascunho: "Transição de status inválida: ACTIVE -> ACTIVE").
 */
async function garantirConexaoDeCanal(tenant, providerCode, label) {
  const { ensureSandboxConnection } = require('../../../src/features/integrations/registry/connections.ensureSandbox');
  await withTenantTransaction(tenant, (transaction) => ensureSandboxConnection({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId }, { providerCode, label }, transaction));
}

module.exports = { isolarConexoesDeCanal, garantirConexaoDeCanal };
