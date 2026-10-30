'use strict';

const repo = require('./pipeline.repository');
const { isOutboundBlocked } = require('../killswitch.state');
const { KEY, DEFAULT_VALUE, parseClasses } = require('./autopublish.settings');

/** Classes ativas da empresa. Valor ilegível no banco = nenhuma classe (falha fechada: na dúvida, aprovação humana). */
async function readClasses(tenant, transaction) {
  const { getSetting } = require('../../settings/settings.service'); // leitura tardia: o dicionário de parâmetros carrega este módulo
  try { return parseClasses(await getSetting(KEY, tenant, transaction, DEFAULT_VALUE)); } catch (err) { return []; }
}

/** Canais pretendidos do conteúdo (gravados na criação, `canais`); sem canal pretendido nenhuma classe casa. */
const requestedChannels = (version) => (version.body_json && Array.isArray(version.body_json.canais) ? version.body_json.canais : []);

/** Classes que cobrem o conteúdo: o tipo casa e CADA canal pretendido tem a sua classe. Vazio quando algum canal fica de fora. */
function matchClasses(classes, type, channels) {
  if (channels.length === 0) return [];
  const ofType = classes.filter((c) => c.tipo === type);
  const matched = channels.map((channel) => ofType.find((c) => c.canal === channel));
  return matched.every(Boolean) ? [...new Set(matched)] : [];
}

async function templateReasons(version, transaction) {
  if (!version.template_id) return ['TEMPLATE_REQUIRED'];
  const template = await repo.findPublishedTemplate({ templateId: version.template_id, anyStatus: true }, transaction);
  if (!template || template.status !== 'PUBLISHED') return ['TEMPLATE_NOT_PUBLISHED'];
  return template.version_no === version.template_version_no ? [] : ['TEMPLATE_VERSION_MISMATCH'];
}

/**
 * M9-D408 item 2 — decide se o conteúdo sai sozinho. TODAS as condições: conteúdo gerado pela NAY (`model_name`), status COMPLIANCE_CHECKED, validador
 * factual ok, sem suspeita de injeção, sanitização ok, template PUBLISHED na versão que o conteúdo usa (o banco já impede publicado ser editado, então o hash do template é coerente), classe ativa que cubra todos os canais
 * pretendidos e kill switch inativo para os canais e a campanha. Qualquer falha devolve `reasons` (todas, não só a primeira) e o conteúdo vai para aprovação
 * humana. Contrato da porta de M9-D406: { autopublish, classId?, channels?, quando?, reasons }.
 */
async function evaluateAutopublish({ item, version, tenant, transaction }) {
  const reasons = [];
  const checks = version.checks_json || {};
  if (!version.model_name) reasons.push('NOT_NAY');
  if (item.status !== 'COMPLIANCE_CHECKED') reasons.push('STATUS_NOT_COMPLIANCE_CHECKED');
  if (!checks.factual || checks.factual.ok !== true) reasons.push('FACTUAL_NOT_OK');
  const findings = checks.factual && checks.factual.detalhes && Array.isArray(checks.factual.detalhes.findings) ? checks.factual.detalhes.findings : [];
  if (findings.some((f) => f && f.reason === 'INJECTION')) reasons.push('INJECTION_SUSPECT');
  if (!checks.compliance || checks.compliance.ok !== true) reasons.push('NOT_SANITIZED');
  reasons.push(...await templateReasons(version, transaction));
  const matched = matchClasses(await readClasses(tenant, transaction), item.type, requestedChannels(version));
  if (matched.length === 0) reasons.push('NO_CLASS');
  const channels = [...new Set(matched.flatMap((c) => c.canais_agendamento))];
  if (matched.length > 0) {
    const kill = await isOutboundBlocked(tenant, { channel: [...new Set([...requestedChannels(version), ...channels])], campaignId: item.campaign_id }, transaction);
    if (kill.blocked) reasons.push('KILL_SWITCH');
  }
  if (reasons.length > 0) return { autopublish: false, reasons };
  return { autopublish: true, classId: matched[0].id, classIds: matched.map((c) => c.id), channels, quando: Math.max(...matched.map((c) => c.quando)), reasons };
}

module.exports = { evaluateAutopublish, readClasses, matchClasses };
