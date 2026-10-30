'use strict';

const { buildModuleRouter } = require('../governance.module');
const { GOVERNANCE_MODULES } = require('../governance.settings');
const controller = require('./finops.controller');
const budgets = require('./budgets/budget.controller');
const degradation = require('./degradation/degradation.controller');

const MODULE = GOVERNANCE_MODULES.find((item) => item.code === 'finops');

// Esqueleto do alicerce (M9-D800): a rota do livro, protegida pela permissão do módulo e pelo liga/desliga do administrador.
const router = buildModuleRouter(MODULE, [
  { method: 'get', path: '/finops/health', permission: 'governance:finops:read', handler: controller.getOverview },
  // M9-D861: orçamentos por ambiente e domínio (alertas 50/75/90/100). Cadastro exige a permissão de gestão; leitura, a de consulta.
  { method: 'get', path: '/finops/budgets', permission: 'governance:finops:read', handler: budgets.list },
  { method: 'post', path: '/finops/budgets', permission: 'governance:finops:manage', handler: budgets.create },
  { method: 'patch', path: '/finops/budgets/:id', permission: 'governance:finops:manage', handler: budgets.update },
  // M9-D863: política de degradação por custo (passos reversíveis e não críticos); PROD nunca é desligado por custo.
  { method: 'get', path: '/finops/degradation-policies', permission: 'governance:finops:read', handler: degradation.list },
  { method: 'put', path: '/finops/degradation-policies', permission: 'governance:finops:manage', handler: degradation.save },
]);

module.exports = router;
