'use strict';

const { InsuranceManualTask, InsurancePolicy, Notification } = require('../../../models');
const { readInsuranceParams } = require('./insurance.params');

const KIND_BY_OPERATION = Object.freeze({ quote: 'QUOTE_DOCUMENT', propose: 'PROPOSAL_NUMBER' });
const ID_PREFIX = 'manual:';

const taskIdOf = (externalResourceId) => (String(externalResourceId || '').startsWith(ID_PREFIX) ? String(externalResourceId).slice(ID_PREFIX.length) : null);
const refOf = (task) => `${ID_PREFIX}${task.id}`;

/**
 * O objeto "antigo" do fluxo manual de seguro (M9-D238 3.2): faz o papel do adapter de uma seguradora sem API. Cotar e propor não chamam rede: abrem uma tarefa para uma pessoa
 * (anexar a cotação recebida por e-mail ou portal, registrar o número da proposta, anexar a apólice) e devolvem PENDING. A conclusão da tarefa (insurance.tasks.js) aplica o resultado
 * pelo MESMO caminho que a resposta da API aplicaria, com os mesmos estados e eventos. Roda na transação do worker de envios (meta.transaction), sob a RLS da empresa.
 */
class ManualInsuranceWorkflow {
  /** Abre a tarefa do envio (uma por envio e tipo: repetir o mesmo pedido devolve a mesma tarefa) e avisa a pessoa responsável. */
  async openTask(meta, { kind, purpose = 'NEW', policyId, request }) {
    const { transaction } = meta;
    const tenant = meta.tenant || {};
    const existente = meta.dispatchId ? await InsuranceManualTask.findOne({ where: { companyId: tenant.companyId, dispatchId: meta.dispatchId, kind }, transaction }) : null;
    if (existente) return existente;
    const policy = await InsurancePolicy.findByPk(policyId, { transaction });
    const params = await readInsuranceParams(tenant, transaction);
    const responsavel = tenant.userId || (policy && policy.createdBy) || null;
    const task = await InsuranceManualTask.create({
      groupId: policy.groupId, companyId: policy.companyId, policyId, dispatchId: meta.dispatchId || null, kind, purpose, assignedToUserId: responsavel,
      dueAt: new Date(Date.now() + params.manualTaskDueDays * 86400000), requestJson: request || {},
    }, { transaction });
    if (responsavel) {
      await Notification.create({
        groupId: policy.groupId, companyId: policy.companyId, userId: responsavel, channel: 'IN_APP', title: 'Tarefa de seguro aguardando você',
        body: `A seguradora não tem integração: ${{ QUOTE_DOCUMENT: 'anexe a cotação recebida', PROPOSAL_NUMBER: 'registre o número da proposta', POLICY_DOCUMENT: 'anexe a apólice' }[kind]} (apólice ${policy.externalPolicyNumber || policy.id}). Prazo: ${params.manualTaskDueDays} dia(s).`,
      }, { transaction });
    }
    return task;
  }

  /** Estado do pedido manual para as consultas do port: a proposta vale ACTIVE quando a tarefa da apólice foi concluída. */
  async statusOf(meta, externalResourceId) {
    const { transaction } = meta;
    const id = taskIdOf(externalResourceId);
    const task = id ? await InsuranceManualTask.findOne({ where: { id, companyId: (meta.tenant || {}).companyId }, transaction }) : null;
    if (!task) return null;
    if (task.kind === 'PROPOSAL_NUMBER') {
      const apolice = await InsuranceManualTask.findOne({ where: { companyId: task.companyId, dispatchId: task.dispatchId, kind: 'POLICY_DOCUMENT' }, transaction });
      if (task.status === 'CANCELLED' || (apolice && apolice.status === 'CANCELLED')) return 'CANCELED';
      return apolice && apolice.status === 'DONE' ? 'ACTIVE' : 'PENDING';
    }
    return { OPEN: 'PENDING', DONE: 'COMPLETED', CANCELLED: 'CANCELED' }[task.status];
  }
}

module.exports = { ManualInsuranceWorkflow, KIND_BY_OPERATION, refOf, taskIdOf, ID_PREFIX };
