'use strict';

/**
 * M9-D004 — os oito agentes do livro (versão 1, em DRAFT e desabilitados) e o hash de configuração usado no seed.
 * O conteúdo de cada agente (política, escopos, tools) é de M9-D034 a M9-D041; aqui entra só código, finalidade e criticidade.
 * `canonicalHash` é cópia de src/features/ai/agents/agentConfigHash.js (uma migration não importa código de aplicação, que muda
 * depois dela); o teste m9d004 confere que as duas dão o mesmo resultado para as linhas do seed.
 */
const crypto = require('node:crypto');

const AGENTES = [
  ['NAY_DIRETORIA', 'Dar à diretoria uma visão consolidada da empresa, somente leitura e sempre com fontes.', 'NON_CRITICAL'],
  ['NAY_COMERCIAL', 'Apoiar o time comercial com pipeline, oportunidades e combinações do Radar, somente leitura e com fontes.', 'NON_CRITICAL'],
  ['NAY_FINANCEIRA', 'Apoiar o financeiro com leitura de lançamentos, fluxo de caixa e conciliação, com números sempre vindos das fontes.', 'CRITICAL'],
  ['NAY_OBRAS', 'Apoiar a gestão de obras com andamento, cronograma, custos e ocorrências, somente leitura e com fontes.', 'NON_CRITICAL'],
  ['NAY_JURIDICA', 'Apoiar o jurídico com contratos, cláusulas, prazos e assinaturas, sem emitir parecer e sempre com fontes.', 'CRITICAL'],
  ['NAY_CORRESPONDENTE', 'Apoiar o correspondente bancário com processos, propostas e documentos de financiamento, com fontes.', 'CRITICAL'],
  ['NAY_DOCUMENTAL', 'Apoiar a leitura e a busca de documentos da empresa, citando o trecho de origem.', 'NON_CRITICAL'],
  ['NAY_ATENDIMENTO', 'Apoiar o atendimento a clientes com histórico de relacionamento, somente leitura e com fontes.', 'NON_CRITICAL'],
];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, k) => { acc[k] = canonical(value[k]); return acc; }, {});
  }
  return value;
}

function canonicalHash({ code, purpose, systemPolicy, modelPolicy, dataScopes, limits, criticality, tools }) {
  const ferramentas = [...(tools || [])]
    .sort((a, b) => (a.toolName < b.toolName ? -1 : 1))
    .map((t) => ({ toolName: t.toolName, permissionCode: t.permissionCode, riskLevel: t.riskLevel, requiresHumanApproval: t.requiresHumanApproval, enabled: t.enabled }));
  const texto = JSON.stringify(canonical({ code, purpose, systemPolicy, modelPolicy, dataScopes, limits, criticality, tools: ferramentas }));
  return crypto.createHash('sha256').update(texto, 'utf8').digest('hex');
}

function linhasDoSeed() {
  return AGENTES.map(([code, purpose, criticality]) => {
    const base = { code, purpose, systemPolicy: '', modelPolicy: {}, dataScopes: [], limits: {}, criticality, tools: [] };
    return { ...base, configHash: canonicalHash(base) };
  });
}

module.exports = { AGENTES, canonicalHash, linhasDoSeed };
