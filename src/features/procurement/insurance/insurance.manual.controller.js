'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const { completeTask, cancelTask, listTasks } = require('./insurance.tasks');
const { addPolicyVersion, listPolicyVersions } = require('./insurance.versions');
const { InsurancePolicy } = require('../../../models');
const AppError = require('../../../utils/AppError');

const actorOf = (req) => ({ userId: req.auth.userId, groupId: req.auth.groupId, companyId: req.auth.companyId });

async function policyOf(req, transaction) {
  const policy = await InsurancePolicy.findOne({ where: { id: req.params.id, groupId: req.auth.groupId, companyId: req.auth.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!policy) throw AppError.notFound('Apólice não encontrada.', 'INSURANCE_POLICY_NOT_FOUND');
  return policy;
}

/** Tarefas do fluxo manual da seguradora e versões do documento da apólice (M9-D238). */
const listInsuranceTasks = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => listTasks({ status: req.query.status, policyId: req.query.policyId }, actorOf(req), t));
  return success(res, { data });
});

const completeInsuranceTask = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => completeTask(req.params.id, req.body, actorOf(req), t));
  return success(res, { data });
});

const cancelInsuranceTask = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => cancelTask(req.params.id, req.body && req.body.reason, actorOf(req), t));
  return success(res, { data });
});

const addPolicyVersionHandler = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction(async (t) => addPolicyVersion(await policyOf(req, t), { ...req.body, source: 'MANUAL' }, actorOf(req), t));
  return success(res, { statusCode: 201, data });
});

const listPolicyVersionsHandler = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => listPolicyVersions(req.params.id, req.auth.companyId, t));
  return success(res, { data });
});

module.exports = { listInsuranceTasks, completeInsuranceTask, cancelInsuranceTask, addPolicyVersion: addPolicyVersionHandler, listPolicyVersions: listPolicyVersionsHandler };
