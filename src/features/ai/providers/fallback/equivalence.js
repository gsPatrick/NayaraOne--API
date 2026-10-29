'use strict';

const { hasCapability, acceptsClassification } = require('../candidates');

const RETENTION_RANK = Object.freeze({ NONE: 0, '30D': 1, PROVIDER_DEFAULT: 2 });
const CLASSES = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];
const STRICT_REGION = ['CONFIDENTIAL', 'RESTRICTED'];

const retentionOf = (e) => e.policy.dataRetention || e.model.dataRetention;
const regionOf = (e) => e.policy.region || e.model.region;
const rankOf = (retention) => (retention in RETENTION_RANK ? RETENTION_RANK[retention] : Number.MAX_SAFE_INTEGER);
const accepted = (e) => CLASSES.filter((c) => acceptsClassification(c, { policy: e.policy, retention: retentionOf(e) }));

/**
 * Equivalência segura (M9-D013, condições 1 a 4): devolve a lista de motivos pelos quais `candidate` NÃO pode substituir `original`
 * (vazia = equivalente). `request`: { requiredCapabilities, classification, regions, structuredOutput, toolUse } do pedido que caiu.
 *  1. declara todas as capabilities do pedido; 2. safetyTier >= o do original;
 *  3. retenção igual ou mais restritiva, região permitida e aceita a classificação do pedido (e todas as que o original aceitava);
 *  4. structuredOutput e toolUse quando o original os usou.
 * As condições 5 (avaliação verde) e 6 (habilitado, circuito fechado, sandbox fora de produção) dependem de estado e ficam no seletor.
 */
function equivalenceProblems(original, candidate, request) {
  const problems = [];
  const caps = request.requiredCapabilities && request.requiredCapabilities.length ? request.requiredCapabilities : ['generate'];
  if (!caps.every((c) => hasCapability(candidate, c))) problems.push('CAPABILITY');
  if (candidate.model.safetyTier < original.model.safetyTier) problems.push('SAFETY_TIER');
  if (rankOf(retentionOf(candidate)) > rankOf(retentionOf(original))) problems.push('RETENTION');
  const classification = request.classification || 'INTERNAL';
  const regions = Array.isArray(request.regions) ? request.regions : [];
  if (regions.length ? !regions.includes(regionOf(candidate)) : STRICT_REGION.includes(classification) && regionOf(candidate) !== regionOf(original)) problems.push('REGION');
  const candidateAccepts = accepted(candidate);
  if (!accepted(original).every((c) => candidateAccepts.includes(c)) || !candidateAccepts.includes(CLASSES.includes(classification) ? classification : 'RESTRICTED')) problems.push('CLASSIFICATION');
  if (request.structuredOutput && candidate.model.structuredOutput !== true) problems.push('STRUCTURED_OUTPUT');
  if (request.toolUse && candidate.model.toolUse !== true) problems.push('TOOL_USE');
  return problems;
}

module.exports = { equivalenceProblems };
