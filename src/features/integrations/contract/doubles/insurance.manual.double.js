'use strict';

/**
 * Fluxo manual de seguro duplo para a suíte de contrato (M9-D238 + M9-D222): a mesma interface do ManualInsuranceWorkflow (openTask, statusOf), em memória. O fluxo real grava a
 * tarefa no banco da empresa, sob a RLS; a suíte de contrato não abre conexão de banco, e a tarefa real é provada nos testes da M9-D238. `meta()` entrega a empresa e a transação
 * de mentira que o adapter manual exige.
 */
function makeManualDouble() {
  const tarefas = new Map();
  return {
    async openTask(_meta, { kind, policyId }) {
      const chave = `${kind}:${policyId}`;
      if (!tarefas.has(chave)) tarefas.set(chave, { id: `tarefa-contrato-${tarefas.size + 1}`, kind });
      return tarefas.get(chave);
    },
    async statusOf(_meta, externalResourceId) {
      return String(externalResourceId).startsWith('manual:') ? 'PENDING' : null;
    },
  };
}

const manualMeta = () => ({ tenant: { groupId: 'contrato', companyId: 'contrato', userId: null }, transaction: { contrato: true } });

module.exports = { makeManualDouble, manualMeta };
