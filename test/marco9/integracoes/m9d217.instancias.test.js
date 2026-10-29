'use strict';

// Marco 9, M9-D217 — o estado do circuito é do banco: vale para duas instâncias ao mesmo tempo e sobrevive a reinício.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { sequelize, carregarTenants, conexaoAtiva, limparCircuito, desativarConexoesDeTeste, linha, errosCircuito, health } = require('../_helpers/m9d217Env');

const FILHO = path.join(__dirname, '..', '_helpers', 'circuitChild.js');
let tenant;

const filho = (modo, id, n = 0) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [FILHO, modo, tenant.groupId, tenant.companyId, id, String(n)], { env: process.env });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`filho saiu com ${code}: ${err}`))));
});

before(async () => { ({ tenant } = await carregarTenants()); await limparCircuito(tenant); });
after(async () => { await limparCircuito(tenant); await desativarConexoesDeTeste(tenant); await sequelize.close(); });

test('circuito_estado_compartilhado_entre_instancias', async () => {
  const c = await conexaoAtiva(tenant, 'MESSAGING');
  // duas instâncias somam 3 + 3 falhas: o contador é um só, a abertura acontece uma vez
  await Promise.all([filho('falhar', c.id, 3), filho('falhar', c.id, 3)]);
  const l = await linha(tenant, c.id);
  assert.equal(l.circuit_state, 'OPEN');
  assert.equal(l.consecutive_failures >= 5, true);
  assert.equal((await errosCircuito(tenant, c.id)).length, 1, 'uma abertura, um erro');
});

test('circuito_estado_sobrevive_reinicio', async () => {
  const c = await conexaoAtiva(tenant, 'MESSAGING');
  await filho('falhar', c.id, 5);
  health.clearCircuitCache(); // "reinício" desta instância
  const lido = await filho('ler', c.id); // outro processo, sem nenhuma memória
  assert.match(lido, /ESTADO:/);
  const estado = JSON.parse(lido.split('ESTADO:')[1]);
  assert.equal(estado.circuit_state, 'OPEN');
  assert.equal(estado.consecutive_failures, 5);
});
