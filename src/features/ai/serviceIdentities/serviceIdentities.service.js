'use strict';

const { Company } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const E = require('./serviceIdentities.errors');
const V = require('./serviceIdentities.validation');
const repo = require('./serviceIdentities.repository');
const { toIdentity, auditSnapshot } = require('./serviceIdentities.mapper');

async function companyName(ctx, transaction) {
  const empresa = await Company.findByPk(ctx.companyId, { attributes: ['name'], transaction });
  return (empresa && empresa.name) || ctx.companyId;
}

const auditar = (ctx, action, id, before, after, reason, transaction) => registrarAuditoria({
  groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId || null, action, entityType: 'AiServiceIdentity', entityId: id,
  beforeJson: before ? auditSnapshot(before) : { registro: 'inexistente' }, afterJson: auditSnapshot(after), reason,
}, transaction);

async function listServiceIdentities(ctx, transaction) {
  V.ctxOk(ctx);
  const nome = await companyName(ctx, transaction);
  return (await repo.list(ctx, transaction)).map((m) => toIdentity(m, nome));
}

async function createServiceIdentity(ctx, body, transaction) {
  V.ctxOk(ctx);
  const dados = await V.parseCreate(body);
  let criada;
  try {
    criada = await repo.insert(ctx, { ...dados, createdBy: ctx.userId || null, updatedBy: ctx.userId || null }, transaction);
  } catch (err) {
    throw E.fromDbError(err) || err;
  }
  const visao = toIdentity(criada, await companyName(ctx, transaction));
  await auditar(ctx, 'ai.service_identity.create', visao.id, null, visao, `Identidade de serviço ${visao.agentCode} criada.`, transaction);
  return visao;
}

async function updateServiceIdentity(ctx, id, body, transaction) {
  V.ctxOk(ctx);
  if (!V.isUuid(id)) throw E.notFound();
  const dados = await V.parseUpdate(body);
  const atual = await repo.findById(ctx, id, transaction, { lock: true });
  if (!atual) throw E.notFound();
  const nome = await companyName(ctx, transaction);
  const antes = toIdentity(atual, nome);
  Object.assign(atual, dados, { updatedBy: ctx.userId || null });
  try {
    await repo.save(atual, transaction);
  } catch (err) {
    throw E.fromDbError(err) || err;
  }
  const depois = toIdentity(atual, nome);
  await auditar(ctx, 'ai.service_identity.update', id, antes, depois, `Identidade de serviço ${depois.agentCode} alterada.`, transaction);
  return depois;
}

module.exports = { listServiceIdentities, createServiceIdentity, updateServiceIdentity };
