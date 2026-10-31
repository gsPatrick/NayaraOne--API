'use strict';

const { Router } = require('express');
const { errorEnvelope } = require('./governance.errors');
const { GOVERNANCE_MODULES } = require('./governance.settings');
const permissionsRouter = require('./governance.permissions.routes');
const { router: migrationRouter } = require('../migration-v2'); // M9-D900: POST /migration/runs (fora das 8 pastas de módulo: é a feature migration-v2)

/**
 * core-governance — camada única de governança operacional do Marco 9 (Caderno, Guia do Marcelo §2). Oito módulos, um por
 * subpasta, todos com a mesma estrutura (index/routes/controller/service/README) e o mesmo padrão de erro, permissão e
 * isolamento por empresa (schema `governance`, RLS FORCE).
 */
const modules = {};
for (const mod of GOVERNANCE_MODULES) modules[mod.code] = require(`./${mod.code}`);

// Prefixos de rota do bloco (os do livro: /calendar, /data-quality, /exports, /api-governance, /finops...). O envelope de
// erro (error.traceId) vale só nestes caminhos, sem tocar as demais rotas de /v1.
const GOVERNANCE_PREFIXES = Object.freeze([
  ...GOVERNANCE_MODULES.map((mod) => mod.prefix),
  '/exports',
  '/retention',
  '/data-classification',
  '/legal-holds',
  '/governance',
]);
  '/migration',

const router = Router();
router.use(GOVERNANCE_PREFIXES, errorEnvelope);
for (const mod of GOVERNANCE_MODULES) router.use(modules[mod.code].router);
router.use(permissionsRouter);

router.use(migrationRouter);
// M9-D825: política de VIEW aplicada na resposta das rotas de pessoas, imóveis, fornecedores, contratos, financeiro e arquivos (montada em src/routes/index.js).
const { viewPolicyRouter } = require('./dlp/view.routes');

module.exports = { router, modules, GOVERNANCE_PREFIXES, viewPolicyRouter };
