'use strict';

// M9-D842 — o contract test só roda em banco descartável: a guarda e o comando `scripts/runContractTests.js`. Sem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { disposableProblem, assertDisposable } = require('../../../src/features/core-governance/api-governance/contract');

const LOCAL = { DISPOSABLE_DB: '1', DATABASE_URL: 'postgres://u:p@127.0.0.1:55000/app', DATABASE_ADMIN_URL: 'postgres://s:p@127.0.0.1:55000/app' };
const SCRIPT = path.resolve(__dirname, '../../../scripts/runContractTests.js');

test('m9d842 suíte roda só em banco descartável: a guarda aceita o cluster local e recusa o resto', () => {
  assert.equal(disposableProblem(LOCAL), null);
  assert.equal(disposableProblem({ ...LOCAL, DATABASE_URL: 'postgres://u:p@localhost:5432/app' }), null);
  const reasons = [
    [{}, /DISPOSABLE_DB não está ligado/],
    [{ ...LOCAL, DISPOSABLE_DB: undefined }, /DISPOSABLE_DB não está ligado/],
    [{ ...LOCAL, DATABASE_URL: 'postgres://u:p@banco.exemplo.com:5432/app' }, /DATABASE_URL não aponta para 127\.0\.0\.1/],
    [{ ...LOCAL, DATABASE_ADMIN_URL: 'postgres://s:p@10.0.0.9:5432/app' }, /DATABASE_ADMIN_URL não aponta/],
    [{ ...LOCAL, DATABASE_URL: undefined }, /DATABASE_URL ausente/],
    [{ ...LOCAL, DATABASE_URL: 'isto não é uma url' }, /DATABASE_URL ausente ou inválida/],
  ];
  for (const [env, pattern] of reasons) {
    const problem = disposableProblem(env);
    assert.equal(problem.code, 'GOV_CONTRACT_DB_NOT_DISPOSABLE');
    assert.match(problem.message, pattern);
    assert.doesNotMatch(JSON.stringify(problem), /postgres:\/\//, 'a conexão nunca aparece na mensagem');
  }
  assert.throws(() => assertDisposable({}), (err) => err.code === 'GOV_CONTRACT_DB_NOT_DISPOSABLE');
});

test('m9d842 suíte roda só em banco descartável: o comando recusa banco compartilhado com exit 2', () => {
  const clean = { PATH: process.env.PATH };
  for (const env of [clean, { ...clean, DATABASE_URL: 'postgres://u:p@banco.exemplo.com:5432/app', DATABASE_ADMIN_URL: 'postgres://s:p@banco.exemplo.com:5432/app', DISPOSABLE_DB: '1' }]) {
    const run = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.match(run.stderr, /^GOV_CONTRACT_DB_NOT_DISPOSABLE O contract test só roda em banco descartável: /);
    assert.doesNotMatch(run.stdout + run.stderr, /banco\.exemplo\.com/);
  }
});

test('m9d842 npm run test:contract usa o cluster descartável e o CI roda em todo pull request', () => {
  const fs = require('node:fs');
  const root = path.resolve(__dirname, '../../..');
  const script = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts['test:contract'];
  assert.match(script, /^node scripts\/withDisposableDb\.js /, 'sobe o cluster descartável antes de qualquer teste');
  assert.match(script, /scripts\/runContractTests\.js/);
  assert.doesNotMatch(script, /DATABASE_URL|postgres:\/\//, 'nenhuma conexão no comando');
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/contract-tests.yml'), 'utf8');
  assert.match(workflow, /^on:\n(?:.*\n)*?\s+pull_request:\n/m, 'roda em pull request');
  assert.doesNotMatch(workflow, /pull_request:\n\s+(branches|paths)/, 'sem filtro de branch ou caminho: todo pull request');
  assert.match(workflow, /run: npm run test:contract/);
  assert.match(workflow, /contract-report\.json/);
  assert.match(workflow, /contract-report\.junit\.xml/);
});
