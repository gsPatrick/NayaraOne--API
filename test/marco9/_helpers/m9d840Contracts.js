'use strict';

// Apoio dos testes M9-D840 (não é teste): contrato mínimo em objeto, cópia para mutar, YAML, execução do lint pelo serviço e pelo comando.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const { lintContracts } = require('../../../src/features/core-governance/api-governance/openapi/lint.service');

const ROOT = path.resolve(__dirname, '../../..');
const json = (schema) => ({ content: { 'application/json': { schema } } });

/** Contrato v1.4.0 com 2 rotas: GET/PATCH /contracts/{id} e GET /contracts (lista), com campos, enum, restrições e segurança. */
const baseContract = () => ({
  openapi: '3.0.3', info: { title: 'Teste', version: '1.4.0' }, security: [{ bearerAuth: [] }],
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
  paths: {
    '/contracts/{id}': {
      get: {
        operationId: 'getContract', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'expand', in: 'query', required: false, schema: { type: 'string' } }],
        responses: {
          200: { description: 'ok', ...json({ type: 'object', required: ['id', 'dueAt', 'status'], properties: { id: { type: 'string' }, dueAt: { type: 'string', format: 'date' }, status: { type: 'string', enum: ['OPEN', 'CLOSED'] }, owner: { type: 'string' } } }) },
          404: { description: 'nao achou', 'x-error-code': 'GOV_NOT_FOUND', ...json({ type: 'object' }) },
        },
      },
      patch: {
        operationId: 'patchContract', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: false, ...json({ type: 'object', required: ['title'], properties: { title: { type: 'string', maxLength: 100 }, note: { type: 'string' }, kind: { type: 'string', enum: ['A', 'B'] } } }) },
        responses: { 200: { description: 'ok', ...json({ type: 'object' }) } },
      },
    },
    '/contracts': { get: { operationId: 'listContracts', responses: { 200: { description: 'ok', ...json({ type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } }) } } } },
  },
});
const clone = (value) => JSON.parse(JSON.stringify(value));
const dump = (doc) => yaml.dump(doc, { lineWidth: 200 });
const lint = (base, candidate, extra = {}) => lintContracts({ baseText: base ? dump(base) : null, candidateText: dump(candidate), candidatePath: path.join(os.tmpdir(), 'openapi.v1.yaml'), ...extra });
const rulesOf = (report) => report.changes.map((c) => c.rule).sort();

/** Pasta temporária com arquivos { nome: texto|objeto }; devolve os caminhos. */
function tmpFiles(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d840-'));
  const out = { dir };
  for (const [name, content] of Object.entries(files)) { out[name] = path.join(dir, name); fs.writeFileSync(out[name], typeof content === 'string' ? content : dump(content)); }
  return out;
}

/** Roda `npm run lint:openapi` equivalente: node scripts/lintOpenapi.js com os argumentos; devolve { status, stdout }. */
const cli = (args) => {
  const run = spawnSync('node', [path.join(ROOT, 'scripts/lintOpenapi.js'), ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, LOG_LEVEL: 'silent' } });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
};

module.exports = { baseContract, clone, dump, lint, rulesOf, tmpFiles, cli, json, ROOT };
