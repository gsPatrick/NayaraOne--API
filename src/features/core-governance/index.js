'use strict';

const { Router } = require('express');
const { errorEnvelope } = require('./governance.errors');
const { GOVERNANCE_MODULES } = require('./governance.settings');
const permissionsRouter = require('./governance.permissions.routes');

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
  '/governance',
]);

const router = Router();
router.use(GOVERNANCE_PREFIXES, errorEnvelope);
for (const mod of GOVERNANCE_MODULES) router.use(modules[mod.code].router);
router.use(permissionsRouter);

module.exports = { router, modules, GOVERNANCE_PREFIXES };
