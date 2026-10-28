'use strict';

const crypto = require('node:crypto');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const repo = require('./definition.repository');
const { parseBody, assertComplete, pickDefinition, isUuid } = require('./definition.validation');
const { definitionHash, rowToDefinition, versionDto, flowDto } = require('./definition.dto');
const { notFound, versionImmutable, reasonRequired, invalidBody, incomplete, codeExists } = require('./definition.errors');

const ENTITY = 'marketing.automation_flow';
const slug = (name) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'AUTOMACAO';

async function ownerProblems(ownerUserId, tenant, transaction) {
  if (!isUuid(ownerUserId)) return [{ field: 'ownerUserId', reason: 'Informe o responsável (usuário ativo da empresa).' }];
  return (await repo.ownerIsActive(ownerUserId, tenant, transaction)) ? [] : [{ field: 'ownerUserId', reason: 'O responsável precisa ser um usuário ativo da empresa.' }];
}

async function audit(tenant, actor, action, flowId, before, after, reason, transaction) {
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor, action, entityType: ENTITY, entityId: flowId,
    beforeJson: before, afterJson: after, reason,
  }, transaction);
}

/**
 * POST /marketing/automations — sem `flowId` cria fluxo + versão 1 (DRAFT; o fluxo fica PAUSED até a primeira publicação); com
 * `flowId` cria a versão N+1 em DRAFT copiando a última versão, com os campos do corpo por cima. A definição precisa estar
 * completa já no rascunho (e é conferida de novo ao publicar).
 */
async function createAutomation({ tenant, actor, input }, transaction) {
  const body = parseBody(input);
  const isNewFlow = !body.flowId;
  let flow = null;
  let base = {};
  if (!isNewFlow) {
    if (body.code !== undefined || body.name !== undefined) throw invalidBody('Código e nome só valem na criação do fluxo.', { fields: ['code', 'name'] });
    flow = await repo.lockFlow(body.flowId, transaction);
    if (!flow) throw notFound();
    base = rowToDefinition(await repo.latestVersion(flow.id, transaction));
  }
  const def = { ...base, ...pickDefinition(body) };
  const ownerUserId = body.ownerUserId || (flow ? flow.owner_user_id : undefined);
  const problems = await ownerProblems(ownerUserId, tenant, transaction);
  if (isNewFlow && !body.name) problems.push({ field: 'name', reason: 'Informe o nome da automação.' });
  assertComplete(def, problems);

  if (isNewFlow) {
    const code = body.code ? body.code.trim() : `${slug(body.name)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    if (await repo.findFlowByCode(code, transaction)) throw codeExists({ code });
    flow = await repo.insertFlow(tenant, actor, { code, name: body.name.trim(), ownerUserId, riskLevel: def.riskLevel }, transaction);
  } else if (body.ownerUserId && body.ownerUserId !== flow.owner_user_id) {
    flow = await repo.updateFlow(flow.id, { ownerUserId: body.ownerUserId }, actor, transaction);
  }
  const versionNo = isNewFlow ? 1 : (await repo.latestVersion(flow.id, transaction)).version_no + 1;
  const version = await repo.insertVersion(tenant, actor, flow.id, versionNo, def, definitionHash(def), transaction);
  await audit(tenant, actor, 'marketing.automation.create_version', flow.id, null,
    { versionNo, status: 'DRAFT', contentHash: version.content_hash, triggerType: def.triggerType, riskLevel: def.riskLevel }, `Versão ${versionNo} da automação criada em rascunho.`, transaction);
  return { created: isNewFlow, flow: flowDto(flow), version: versionDto(version) };
}

function parsePublishBody(input) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const unknown = Object.keys(body).filter((k) => !['versionNo', 'reason'].includes(k));
  if (unknown.length > 0) throw invalidBody(`Dados inválidos: campo(s) desconhecido(s): ${unknown.join(', ')}.`, { unknown });
  if (body.versionNo === undefined || body.versionNo === null) throw incomplete([{ field: 'versionNo', reason: 'Informe a versão a publicar.' }]);
  if (!Number.isInteger(body.versionNo) || body.versionNo < 1) throw invalidBody('Dados inválidos: versionNo.', { field: 'versionNo' });
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason || reason.length > 500) throw reasonRequired();
  return { versionNo: body.versionNo, reason };
}

/**
 * POST /marketing/automations/:id/publish `{versionNo, reason}` — :id é o fluxo. Publica o DRAFT indicado (a PUBLISHED/PAUSED anterior
 * vira SUPERSEDED) ou retoma a versão PAUSED indicada. Repetir a publicação da versão já PUBLISHED devolve replay sem efeito.
 */
async function publishAutomation({ tenant, actor, flowId, input }, transaction) {
  const { versionNo, reason } = parsePublishBody(input);
  const flow = isUuid(flowId) ? await repo.lockFlow(flowId, transaction) : null;
  if (!flow) throw notFound();
  const target = await repo.lockVersionByNo(flow.id, versionNo, transaction);
  if (!target) throw notFound();
  if (target.status === 'SUPERSEDED') throw versionImmutable({ versionNo, status: target.status });
  if (target.status === 'PUBLISHED') return { replay: true, flow: flowDto(flow), version: versionDto(target), superseded: null, versions: await summary(flow.id, transaction) };

  assertComplete(rowToDefinition(target), await ownerProblems(flow.owner_user_id, tenant, transaction));
  const live = await repo.liveVersion(flow.id, transaction);
  let superseded = null;
  if (live && live.id !== target.id) {
    await repo.setVersionStatus(live.id, 'SUPERSEDED', actor, transaction);
    superseded = { versionNo: live.version_no, status: 'SUPERSEDED' };
  }
  const resumed = target.status === 'PAUSED';
  const published = await repo.setVersionStatus(target.id, 'PUBLISHED', actor, transaction);
  const updatedFlow = await repo.updateFlow(flow.id, { status: 'ACTIVE', riskLevel: published.risk_level, publishedVersionId: published.id }, actor, transaction);
  await audit(tenant, actor, resumed ? 'marketing.automation.resume' : 'marketing.automation.publish', flow.id,
    { flowStatus: flow.status, publishedVersionId: flow.published_version_id, versionStatus: target.status },
    { flowStatus: 'ACTIVE', publishedVersionId: published.id, versionNo, supersededVersionNo: superseded ? superseded.versionNo : null }, reason, transaction);
  return { replay: false, resumed, flow: flowDto(updatedFlow), version: versionDto(published), superseded, versions: await summary(flow.id, transaction) };
}

/**
 * POST /marketing/automations/:id/pause — para de aceitar gatilhos imediatamente: a versão PUBLISHED vira PAUSED e o fluxo vira
 * PAUSED na MESMA transação; nada da configuração é apagado. Já pausado: replay sem efeito.
 */
async function pauseAutomation({ tenant, actor, flowId, input }, transaction) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const unknown = Object.keys(body).filter((k) => k !== 'reason');
  if (unknown.length > 0) throw invalidBody(`Dados inválidos: campo(s) desconhecido(s): ${unknown.join(', ')}.`, { unknown });
  const flow = isUuid(flowId) ? await repo.lockFlow(flowId, transaction) : null;
  if (!flow) throw notFound();
  const live = await repo.liveVersion(flow.id, transaction);
  if (flow.status === 'PAUSED' || !live || live.status !== 'PUBLISHED') {
    return { replay: true, flow: flowDto(flow), version: live ? versionDto(live) : null, versions: await summary(flow.id, transaction) };
  }
  const paused = await repo.setVersionStatus(live.id, 'PAUSED', actor, transaction);
  const updatedFlow = await repo.updateFlow(flow.id, { status: 'PAUSED' }, actor, transaction);
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'Automação pausada.';
  await audit(tenant, actor, 'marketing.automation.pause', flow.id, { flowStatus: 'ACTIVE', versionNo: live.version_no, versionStatus: 'PUBLISHED' },
    { flowStatus: 'PAUSED', versionNo: live.version_no, versionStatus: 'PAUSED' }, reason, transaction);
  return { replay: false, flow: flowDto(updatedFlow), version: versionDto(paused), versions: await summary(flow.id, transaction) };
}

async function summary(flowId, transaction) {
  return (await repo.listVersions(flowId, transaction)).map((v) => ({ versionNo: v.version_no, status: v.status }));
}

module.exports = { createAutomation, publishAutomation, pauseAutomation };
