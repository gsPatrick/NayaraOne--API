'use strict';

// DI-IA-LEVE-1 — "agora" da NAY vem do relógio injetável (src/features/ai/clock), não de new Date() solto.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiRuns');

const RAIZ = path.join(__dirname, '..', '..', '..', 'src', 'features', 'ai');
const ARQUIVOS = ['agents/nay_juridica/juridica.toolServices.js', 'agents/nay_correspondente/readers.js', 'agents/nay_documental/services.js', 'budgets/cache.service.js'];
const FIXO = new Date('2026-03-04T05:06:07.000Z');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

test('m9dleve1_relogio_injetavel_fixa_e_restaura', () => {
  const clock = require('../../../src/features/ai/clock');
  clock.setClock(() => FIXO);
  try {
    assert.equal(clock.now().toISOString(), FIXO.toISOString());
    assert.notEqual(clock.now(), clock.now(), 'cada leitura devolve uma Date nova (ninguém muta a do outro)');
  } finally { clock.resetClock(); }
  assert.ok(Math.abs(clock.now().getTime() - Date.now()) < 5000);
});

test('m9dleve1_nenhum_dos_quatro_arquivos_le_new_date_solto', () => {
  for (const rel of ARQUIVOS) {
    const codigo = fs.readFileSync(path.join(RAIZ, rel), 'utf8');
    assert.ok(!/new Date\(\s*\)/.test(codigo), `${rel} ainda chama new Date()`);
    assert.match(codigo, /clock/, `${rel} deveria usar o relógio injetável`);
  }
});

test('m9dleve1_juridica_passa_o_instante_do_relogio_as_leituras', async () => {
  const clock = require('../../../src/features/ai/clock');
  const data = require('../../../src/features/ai/agents/nay_juridica/juridica.data');
  const { legalNay } = require('../../../src/features/ai/agents/nay_juridica/juridica.toolServices');
  const vistos = [];
  const originais = {};
  for (const fn of ['contractSummary', 'compareVersions', 'requirementsChecklist', 'contractDeadlines']) {
    originais[fn] = data[fn];
    data[fn] = async (...args) => { vistos.push(args.find((a) => a instanceof Date)); return {}; };
  }
  clock.setClock(() => FIXO);
  try {
    await withRollbackTenantTransaction(tenantA, async (tx) => {
      const s = legalNay(tx, { groupId: tenantA.groupId, companyId: tenantA.companyId });
      await s.getContractSummary('c'); await s.compareVersions('c', 1, 2); await s.getRequirementsChecklist('c'); await s.getDeadlines('c');
    });
  } finally { Object.assign(data, originais); clock.resetClock(); }
  assert.equal(vistos.length, 4);
  for (const v of vistos) assert.equal(v.toISOString(), FIXO.toISOString());
});
