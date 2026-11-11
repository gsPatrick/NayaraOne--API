'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const { checkDraft, OVERRIDE_PERMISSION } = require('./personDedupGate');
const { listRoleCatalog } = require('./personRoles.service');

const tenantOf = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId });

/**
 * POST /people/duplicates/check — a tela de "Novo contato" consulta, ANTES de criar, o que o portão de deduplicação encontraria
 * (livro §4 e CRMX-010; DI-M3PE-4): forte (abre o existente ou oferece o vínculo do grupo), médio (candidatos e se a pessoa usuária pode
 * criar com motivo) e fraco (candidatos para revisar). Não grava a pessoa.
 */
const check = catchAsync(async (req, res) => {
  const ctx = { ...tenantOf(req), actorUserId: req.auth.userId, podeForcarDuplicidade: req.auth.permissions.includes(OVERRIDE_PERMISSION) };
  const result = await req.withTenantTransaction((transaction) => checkDraft(req.body || {}, ctx, transaction));
  result.forte.podeVincular = req.auth.permissions.includes('people:link');
  return success(res, { data: result });
});

/** GET /people/roles-catalog — papéis aceitos nesta empresa (parâmetro people.papeis; os cinco do livro sempre presentes). */
const rolesCatalog = catchAsync(async (req, res) => {
  const catalog = await req.withTenantTransaction((transaction) => listRoleCatalog(tenantOf(req), transaction));
  return success(res, { data: catalog });
});

module.exports = { check, rolesCatalog };
