'use strict';

const { IntegrationProvider } = require('../../../models');
const { FAMILY_DEFAULT_MODE } = require('./contingency.constants');
const { modeQueueMaxAgeH, readContingencyParams } = require('./contingency.params');
const { CAMPOS_DA_POLITICA, contingencyProblems } = require('./contingency.policyRules');

const valida = (secao) => (secao && typeof secao === 'object' && !Array.isArray(secao) ? Object.fromEntries(Object.entries(secao).filter(([k, v]) => CAMPOS_DA_POLITICA.includes(k) && contingencyProblems({ [k]: v }).length === 0)) : {});

/**
 * Política de contingência efetiva (M9-D226 3.1): padrão da família < `providers.default_policy_json.contingency` < `connections.policy_json.contingency`,
 * campo a campo. Família sem modo padrão e sem modo na política: devolve null (só a fila e a nova tentativa de D214 e D216).
 * Devolve { domain, mode, queueMaxAgeH (null sem fila), alternateConnectionId, manualTaskAssigneeRole, notifyRoles }.
 */
async function resolvePolicyFor(ctx, { providerCode, domain, connection }, transaction) {
  const provider = await IntegrationProvider.findByPk(providerCode, { attributes: ['code', 'domain', 'defaultPolicyJson'], transaction });
  const familia = domain || (provider && provider.domain);
  if (!familia) return null;
  const doFornecedor = valida(provider && provider.defaultPolicyJson && provider.defaultPolicyJson.contingency);
  const daConnection = valida(connection && connection.policyJson && connection.policyJson.contingency);
  const camadas = { ...doFornecedor, ...daConnection };
  const mode = camadas.mode || FAMILY_DEFAULT_MODE[familia];
  if (!mode) return null;
  const params = await readContingencyParams(ctx, transaction);
  // Banco: a régua é uma só (`integration.bank.max_pending_hours`) e `queue_max_age_h` não é lido; IA não tem fila.
  const padraoDoModo = await modeQueueMaxAgeH(mode, ctx, transaction);
  const proprio = mode === 'NO_ASSUME_AND_QUERY' ? null : camadas.queue_max_age_h;
  return {
    domain: familia,
    mode,
    queueMaxAgeH: padraoDoModo === null ? null : (proprio || padraoDoModo),
    alternateConnectionId: camadas.alternate_connection_id || null,
    manualTaskAssigneeRole: camadas.manual_task_assignee_role || params.assigneeRole,
    notifyRoles: camadas.notify_roles || params.notifyRoles,
  };
}

const resolveContingencyPolicy = (ctx, connection, transaction) => resolvePolicyFor(ctx, { providerCode: connection.providerCode, connection }, transaction);

module.exports = { resolveContingencyPolicy, resolvePolicyFor };
