'use strict';

const { equivalenceProblems } = require('../../providers/fallback/equivalence');
const { SANDBOX_MODELS } = require('../../providers/sandbox/sandboxModels');
const { budgetPolicy } = require('../../budgets/budgets.policy');
const { readBudgetParams } = require('../../budgets/budgets.params');
const { STATUSES: MEMORY_STATUSES } = require('../../memory/memory.constants');
const { recallMemories } = require('../../memory/memory.recall');

/** Sondas da suíte adversarial (M9-D042) sobre política: fallback seguro, degradação por orçamento e memória invalidada. Só leitura. */
const entrada = (providerCode, safetyTier) => ({ providerCode, policy: {}, model: { ...SANDBOX_MODELS[0], model: `${providerCode}-m`, safetyTier, dataRetention: 'NONE', region: 'BR' }, capabilities: ['generate'] });

async function modeloCai() {
  const original = entrada('sonda-a', 3);
  const seguro = equivalenceProblems(original, entrada('sonda-b', 3), { requiredCapabilities: ['generate'] });
  const inferior = equivalenceProblems(original, entrada('sonda-c', 2), { requiredCapabilities: ['generate'] });
  return { passed: seguro.length === 0 && inferior.includes('SAFETY_TIER'), expected: 'fallback só para modelo equivalente; inferior falha fechada', actual: `equivalente: ${seguro.join(',') || 'ok'}; inferior: ${inferior.join(',') || 'aceito'}` };
}

async function budgetEstoura(env) {
  const { actionAt100, degradeFrom } = await readBudgetParams(env.runtime.ctx, env.runtime.transaction);
  const nivel = (pct) => (p) => pct >= p;
  const a90 = budgetPolicy({ reached: nivel(degradeFrom), criticality: 'NON_CRITICAL', actionAt100, degradeFrom });
  const a100 = budgetPolicy({ reached: nivel(100), criticality: 'NON_CRITICAL', actionAt100, degradeFrom });
  const critico = budgetPolicy({ reached: nivel(100), criticality: 'CRITICAL', actionAt100, degradeFrom });
  const semAvancado = (r) => !r.allowedPaths.includes('ADVANCED_MODEL');
  const passed = semAvancado(a90) && a90.allowedPaths.includes('SMALL_MODEL') && semAvancado(a100) && !a100.allowedPaths.includes('SMALL_MODEL') && semAvancado(critico) && critico.allowedPaths.includes('SMALL_MODEL');
  return { passed, expected: 'sem avançado a partir do limiar; não crítico só regra (ou regra e cache) a 100%; crítico segue com o pequeno', actual: `limiar ${a90.allowedPaths.join('/')}; 100% ${a100.allowedPaths.join('/')}; crítico ${critico.allowedPaths.join('/')}` };
}

async function memoriaInvalidada(env) {
  const sujeito = { type: 'Property', id: '00000000-0000-4000-8000-00000000f011' };
  const lidas = await recallMemories({ ...env.runtime.ctx, permissions: ['ai:use'] }, { subject: sujeito }, env.runtime.transaction);
  return { passed: MEMORY_STATUSES.includes('INVALIDATED') && lidas.every((m) => m.status === 'ACTIVE'), expected: 'a recuperação devolve só memória ACTIVE', actual: `${lidas.length} memórias, todas ACTIVE` };
}

module.exports = { modeloCai, budgetEstoura, memoriaInvalidada };
