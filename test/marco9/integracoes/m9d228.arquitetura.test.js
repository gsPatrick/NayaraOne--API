'use strict';

// Marco 9, M9-D228 — o parâmetro do papel do financeiro existe no dicionário e é lido pelo código, a regra do banco e do financiamento mora nos ganchos do framework e o caminho
// determinístico da IA não conhece fornecedor. Banco descartável.
process.env.PORT = process.env.M9D228_ARQ_PORT || '22282';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env = require('../_helpers/m9d227Env');
const hooks = require('../../../src/features/integrations/contingency/contingency.domainHooks');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { resolveDomainAssignee } = require('../../../src/features/integrations/contingency/contingency.assignee');

let tenant;
before(async () => { tenant = (await env.carregarTenants()).tenant; require('../../../src/features/finance/bank'); require('../../../src/features/correspondent/dispatch/submitViaDispatch'); });
after(async () => { await env.restaurar(tenant, ['integration.bank.manual_task_assignee_role']); await env.sequelize.close(); process.exit(0); });

const SRC = path.join(__dirname, '../../../src');
const lerTudo = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? lerTudo(path.join(dir, d.name)) : (d.name.endsWith('.js') ? [{ file: path.join(dir, d.name), text: fs.readFileSync(path.join(dir, d.name), 'utf8') }] : [])));

test('contingencia_banco_parametro_do_papel_declarado_e_lido', async () => {
  const k = 'integration.bank.manual_task_assignee_role';
  assert.ok(SETTINGS_SCHEMA[k], `${k} declarado em SETTINGS_SCHEMA`);
  assert.ok(lerTudo(path.join(SRC, 'features')).some((f) => !/\.settings\.js$/.test(f.file) && f.text.includes(`'${k}'`) && /resolveDomainAssignee\(/.test(f.text)), `${k} é lido pelo código`);
  // Sem ninguém no papel configurado, a tarefa vai para o papel das tarefas manuais da contingência (nunca fica sem responsável se houver um).
  const comPapelInexistente = await env.comTenant(tenant, async (t) => {
    await env.parametro(tenant, k, 'Papel que não existe');
    return resolveDomainAssignee({ groupId: tenant.groupId, companyId: tenant.companyId }, k, 'Financeiro', t);
  });
  const reserva = await env.comTenant(tenant, (t) => resolveDomainAssignee({ groupId: tenant.groupId, companyId: tenant.companyId }, 'integration.contingency.manual_task_assignee_role', 'ADMIN', t));
  assert.equal(comPapelInexistente, reserva);
  await assert.rejects(env.parametro(tenant, k, ''), (e) => e.statusCode === 400 && e.code === 'SETTING_INVALID_VALUE');
});

test('contingencia_banco_e_financiamento_registrados_nos_ganchos_do_framework', async () => {
  const banco = hooks.registered('BANK');
  assert.deepEqual([banco.taskBuilder, banco.agedStatuses, banco.drained], [true, true, true]);
  assert.deepEqual(hooks.extraAgedStatuses('BANK'), ['UNKNOWN', 'SUBMITTED']);
  assert.equal(hooks.registered('FINANCING').step, true);
  assert.deepEqual(hooks.extraAgedStatuses('MESSAGING'), [], 'só o banco soma estados incertos à idade da pendência');
});

test('contingencia_ia_caminho_deterministico_nao_conhece_fornecedor', async () => {
  const proibido = /@anthropic-ai|openai|require\('(?:\.\.\/)+providers\/(?:anthropic|openai)/i;
  const arquivos = lerTudo(path.join(SRC, 'features/ai/deterministic'));
  assert.ok(arquivos.length >= 7);
  assert.deepEqual(arquivos.filter((f) => proibido.test(f.text)).map((f) => path.basename(f.file)), []);
  assert.deepEqual(arquivos.filter((f) => f.text.split('\n').length > 400).map((f) => path.basename(f.file)), []);
});
