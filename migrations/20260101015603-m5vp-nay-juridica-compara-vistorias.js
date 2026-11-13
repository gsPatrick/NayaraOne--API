'use strict';

/**
 * Fechamento M5 (vistorias e prazos) — M5-A0092, livro §11 "NAY pode comparar entrada x saída e sugerir diferenças; humano valida
 * responsabilidade/cobrança". O padrão do sistema da NAY Jurídica (versão 1, DRAFT) ganha a tool de leitura legal.compareInspections,
 * o escopo legal.inspections, a frase da política e o caso de golden da escolha da tool (conteúdo em _helpers/aiAgentJuridica.js,
 * espelho de src/features/ai/agents/nay_juridica/juridica.policy.js). Empresa que já ativou a NAY Jurídica recebe a tool na próxima
 * versão que criar (as versões já homologadas não mudam: governança da IA). Se o padrão do sistema já saiu de DRAFT, nada muda e a
 * migration avisa. Reversível: a volta reaplica o conteúdo anterior e tira o caso de golden novo.
 */
const { aplicarAgente, semearGolden, comForcaDesligada } = require('./_helpers/aiAgentContentApply');
const { AGENTE, GOLDEN } = require('./_helpers/aiAgentJuridica');

const TABELAS = ['ai.agents', 'ai.agent_tools', 'ai.golden_cases'];
const CASO_NOVO = 'juridica_tool_comparar_vistorias';

// Conteúdo anterior (migration 749), para a volta.
const tool = (toolName, permissionCode, riskLevel = 'LOW', requiresHumanApproval = false) => ({ toolName, permissionCode, riskLevel, requiresHumanApproval, enabled: true });
const ANTERIOR = {
  ...AGENTE,
  purpose: 'Resumir contratos, comparar versões, montar checklist de requisitos e rascunhar minuta; nunca emitir decisão jurídica final.',
  systemPolicy: AGENTE.systemPolicy.split('\n').filter((l) => !l.startsWith('Compare a vistoria de entrada')).join('\n'),
  dataScopes: ['legal.contracts', 'legal.contract_versions', 'legal.requirements', 'legal.addenda', 'knowledge.homologated'],
  tools: [
    tool('legal.getContractSummary', 'legal:read'), tool('legal.compareVersions', 'legal:read'), tool('legal.getRequirementsChecklist', 'legal:read'), tool('legal.getDeadlines', 'legal:read'), tool('legal.getExpiringContracts', 'legal:read'),
    tool('knowledge.search', 'ai:use'), tool('legal.draftContract', 'legal:create', 'HIGH', true),
  ],
};

async function aindaDraft(q) {
  const [rows] = await q("SELECT status FROM ai.agents WHERE company_id IS NULL AND code = 'NAY_JURIDICA' AND version = 1");
  return rows.length && rows[0].status === 'DRAFT';
}

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await comForcaDesligada(q, TABELAS, async () => {
        if (await aindaDraft(q)) await aplicarAgente(q, AGENTE);
        else await q("DO $n$ BEGIN RAISE NOTICE 'NAY_JURIDICA v1 do sistema já saiu de DRAFT: compareInspections entra só por versão nova da empresa.'; END $n$");
        await semearGolden(q, AGENTE.code, GOLDEN.filter((c) => c.caseKey === CASO_NOVO));
      });
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await comForcaDesligada(q, TABELAS, async () => {
        if (await aindaDraft(q)) await aplicarAgente(q, ANTERIOR);
        // Caso do golden é imutável (gatilho AI044): só sai com o gatilho desligado dentro desta transação.
        await q('ALTER TABLE ai.golden_cases DISABLE TRIGGER USER');
        await q("DELETE FROM ai.golden_cases WHERE company_id IS NULL AND agent_code = 'NAY_JURIDICA' AND case_key = :k", { k: CASO_NOVO });
        await q('ALTER TABLE ai.golden_cases ENABLE TRIGGER USER');
      });
    });
  },
};
