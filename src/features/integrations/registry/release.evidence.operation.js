'use strict';

const { sequelize } = require('../../../models');
const adapterRegistry = require('./adapterRegistry');
const { egressHostsOf } = require('./adapterCtx');
const { effectiveCriticality } = require('../providers/catalog.service');
const { LAB_ENVIRONMENTS } = require('./release.constants');

/** Evidência 4: a ÚLTIMA verificação de saúde em laboratório (connection de SANDBOX ou HOMOLOG do mesmo fornecedor e empresa) está verde. */
async function healthLabProblem(connection, transaction) {
  const [linha] = await sequelize.query(
    `SELECT h.last_check_at, h.last_check_ok FROM integration.provider_health h JOIN integration.connections c ON c.id = h.connection_id
      WHERE h.window_minutes = 0 AND c.company_id = :co AND c.provider_code = :p AND c.environment IN (:lab) AND h.last_check_at IS NOT NULL
      ORDER BY h.last_check_at DESC LIMIT 1`,
    { replacements: { co: connection.companyId, p: connection.providerCode, lab: LAB_ENVIRONMENTS }, transaction, type: sequelize.QueryTypes.SELECT },
  );
  if (!linha) return { code: 'INTEGRATION_RELEASE_HEALTH_LAB_MISSING', message: 'Falta uma verificação de saúde em laboratório deste fornecedor.', detail: 'nenhuma verificação em SANDBOX ou HOMOLOG' };
  if (linha.last_check_ok !== true) return { code: 'INTEGRATION_RELEASE_HEALTH_LAB_FAILED', message: 'A última verificação de saúde em laboratório não está verde.', detail: 'última verificação reprovada' };
  return null;
}

/** Evidência 7: egress allowlist cadastrada (hosts que o adapter declara mais os da connection, M9-D244). */
function egressProblem(connection) {
  const instancia = adapterRegistry.instantiate(connection.providerCode);
  const hosts = egressHostsOf(connection, instancia ? instancia.allowedHosts() : []);
  return hosts.length ? null : { code: 'INTEGRATION_RELEASE_EGRESS_MISSING', message: 'Falta cadastrar a lista de destinos permitidos (egress) desta integração.', detail: 'nenhum host permitido' };
}

/** Evidência 8 (INT-015): família CRITICAL exige `policy.contingency` válida (na connection ou no padrão do fornecedor) com modo resolvido. */
async function contingencyProblem(connection, provider, ctx, transaction) {
  if ((await effectiveCriticality(provider.domain, ctx, transaction)) !== 'CRITICAL') return null;
  const { contingencyProblems, resolveContingencyPolicy } = require('../contingency'); // tardio: o framework de contingência carrega o worker de envios, que depende deste registro
  const doConnection = (connection.policyJson || {}).contingency;
  const doFornecedor = (provider.defaultPolicyJson || {}).contingency;
  const secao = doConnection !== undefined ? doConnection : doFornecedor;
  const faltou = (detail) => ({ code: 'INTEGRATION_RELEASE_CONTINGENCY_MISSING', message: 'Esta integração é de família crítica e precisa de contingência definida (policy.contingency).', detail });
  if (!secao || typeof secao !== 'object' || Array.isArray(secao) || !Object.keys(secao).length) return faltou('policy.contingency não definida');
  const problemas = contingencyProblems(secao);
  if (problemas.length) return faltou(problemas);
  const efetiva = await resolveContingencyPolicy(ctx, connection, transaction);
  return efetiva && efetiva.mode ? null : faltou('policy.contingency sem modo');
}

module.exports = { healthLabProblem, egressProblem, contingencyProblem };
