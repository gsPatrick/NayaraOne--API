'use strict';

const { Router } = require('express');
const { enforceViewPolicy } = require('./view.middleware');

/**
 * Onde a política de VIEW é aplicada (M9-D825 §3.1 item 3): o prefixo de rota de cada módulo que devolve dado de pessoas, imóveis, fornecedores, contratos,
 * financeiro e arquivos e o tipo de recurso do registro de campos sensíveis (`governanca.dlp.view.campos`, ou o registro de classificação da M9-D910). Tipo sem campo
 * HIGH ou RESTRICTED no registro passa sem custo; campo novo no registro entra no escopo sem mexer aqui. Cada prefixo tem caminho próprio: nenhum `router.use` sem caminho.
 */
const VIEW_SCOPES = Object.freeze([
  { prefix: '/people', resourceType: 'people.person' },
  { prefix: '/properties', resourceType: 'properties.property' },
  { prefix: '/procurement', resourceType: 'procurement.supplier' },
  { prefix: '/legal/contracts', resourceType: 'legal.contract' },
  { prefix: '/finance', resourceType: 'finance.bank_account' },
  { prefix: '/files', resourceType: 'files.file' },
]);

const viewPolicyRouter = Router();
for (const scope of VIEW_SCOPES) viewPolicyRouter.use(scope.prefix, enforceViewPolicy(scope.resourceType));

module.exports = { viewPolicyRouter, VIEW_SCOPES };
