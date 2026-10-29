'use strict';

// M9-D016 — o registry é do servidor: o modelo não define permissão nem risco, a saída é podada pelo schema,
// e nenhuma tool toca o banco (só serviço de aplicação ou read model).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ToolRegistry } = require('../../../src/features/ai/tools');
const { executeTool } = require('../../../src/features/ai/tools/toolExecutor');
const { sanitizeModelToolCall } = require('../../../src/features/ai/tools/modelToolCall');
const { varrer } = require('../../../scripts/lib/aiArchGuard');
const { PERMISSION_CODES, ID, LIMITES, defValida } = require('../_helpers/aiToolDefs');

const TOOLS_DIR = path.join(__dirname, '..', '..', '..', 'src', 'features', 'ai', 'tools');
const novo = () => new ToolRegistry({ permissionCodes: PERMISSION_CODES });
const recorder = () => { const linhas = []; return { linhas, record: async (l) => { linhas.push(l); }, emit: async () => {} }; };
const partes = (services = {}) => ({ auth: { userId: 'u1', permissions: ['ai:use'] }, companyId: 'c1', groupId: 'g1', services, correlationId: 'corr' });

function listar(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listar(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

test('m9d016_modelo_nao_escolhe_permission', async () => {
  const reg = novo();
  reg.register(defValida({ permissionCode: 'ai:admin', riskLevel: 'HIGH', requiresHumanApproval: true, name: 'teste.sensivel' }));
  reg.register(defValida());
  // Exemplo do livro: o modelo devolve permissionCode "*"; o campo é descartado e vale o da definição.
  const bruta = { name: 'teste.lerAlgo', permissionCode: '*', arguments: { id: '3f8b7c1e-0c0e-4c6e-9d54-7a1b2c3d4e5f' }, risk_level: 'LOW', requiresHumanApproval: false, requires_human_approval: false };
  const limpa = sanitizeModelToolCall(bruta);
  assert.deepEqual(Object.keys(limpa).sort(), ['arguments', 'discarded', 'name']);
  assert.deepEqual(limpa.discarded.sort(), ['permissionCode', 'requiresHumanApproval', 'requires_human_approval', 'risk_level']);
  assert.equal(reg.get(limpa.name).permissionCode, 'ai:use', 'a permissão é a da definição, não a do modelo');
  assert.equal(reg.get('teste.sensivel').requiresHumanApproval, true);
  // Inclusive aninhado nos argumentos: o servidor não os lê como configuração.
  const aninhada = sanitizeModelToolCall({ name: 'teste.lerAlgo', arguments: { id: 'x' }, tool: { permissionCode: 'a' } });
  assert.deepEqual(aninhada.discarded, ['tool']);
  // O prompt recebe só nome, descrição e o schema enxuto, nunca permissão, risco ou aprovação.
  const visao = reg.promptViewFor(['teste.lerAlgo', 'teste.sensivel', 'nao.permitida']);
  assert.deepEqual(visao.map((v) => v.name), ['teste.lerAlgo', 'teste.sensivel']);
  for (const v of visao) {
    assert.deepEqual(Object.keys(v).sort(), ['description', 'inputSchema', 'name']);
    assert.ok(!/permissionCode|riskLevel|requiresHumanApproval|execute/.test(JSON.stringify(v)));
  }
});

test('m9d016_saida_podada_pelo_output_schema', async () => {
  const reg = novo();
  reg.register(defValida({ execute: async () => ({ id: 'a', nome: 'João', cpf: '123.456.789-09', password_hash: 'xx', extra: { fundo: 1 } }) }));
  const rec = recorder();
  const r = await executeTool({ registry: reg.executorMap(), toolName: 'teste.lerAlgo', input: { id: ID }, contextParts: partes(), recorder: rec, argsLimits: LIMITES });
  assert.equal(r.status, 'SUCCEEDED');
  assert.deepEqual(r.output, { id: 'a', nome: 'João' }, 'colunas fora do schema não saem');
  // Tipo errado ou campo obrigatório ausente na saída não passa.
  const ruim = novo();
  ruim.register(defValida({ execute: async () => ({ nome: 'sem id' }) }));
  await assert.rejects(executeTool({ registry: ruim.executorMap(), toolName: 'teste.lerAlgo', input: { id: ID }, contextParts: partes(), recorder: recorder(), argsLimits: LIMITES }), { code: 'AI_TOOL_OUTPUT_INVALID' });
  const tipo = novo();
  tipo.register(defValida({ execute: async () => ({ id: 123 }) }));
  await assert.rejects(executeTool({ registry: tipo.executorMap(), toolName: 'teste.lerAlgo', input: { id: ID }, contextParts: partes(), recorder: recorder(), argsLimits: LIMITES }), { code: 'AI_TOOL_OUTPUT_INVALID' });
  // Poda recursiva em objeto aninhado e lista.
  const lista = novo();
  lista.register(defValida({
    outputSchema: { type: 'object', properties: { itens: { type: 'array', items: { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] } } }, required: ['itens'] },
    execute: async () => ({ itens: [{ a: 1, segredo: 's' }, { a: 2 }] }),
  }));
  const rl = await executeTool({ registry: lista.executorMap(), toolName: 'teste.lerAlgo', input: { id: ID }, contextParts: partes(), recorder: recorder(), argsLimits: LIMITES });
  assert.deepEqual(rl.output, { itens: [{ a: 1 }, { a: 2 }] });
});

test('m9d016_escrita_nunca_executa_direto_por_padrao', async () => {
  const reg = novo();
  let executou = false;
  reg.register(defValida({ name: 'teste.escreveLow', category: 'WRITE', idempotent: false, execute: async () => { executou = true; return { id: 'z' }; } }));
  const propostas = [];
  const proposeAction = async (p) => { propostas.push(p); return { id: 'prop-1' }; };
  const r = await executeTool({ registry: reg.executorMap(), toolName: 'teste.escreveLow', input: { id: ID }, contextParts: partes(), recorder: recorder(), proposeAction, argsLimits: LIMITES });
  assert.equal(r.status, 'PROPOSED');
  assert.equal(executou, false);
  assert.equal(propostas.length, 1);
  // Só uma decisão explícita de quem chama (D019) libera escrita direta de baixo risco.
  const livre = await executeTool({ registry: reg.executorMap({ allowDirectWrite: () => true }), toolName: 'teste.escreveLow', input: { id: ID }, contextParts: partes(), recorder: recorder(), proposeAction, argsLimits: LIMITES });
  assert.equal(livre.status, 'SUCCEEDED');
  assert.equal(executou, true);
});

test('m9d016_tool_nao_usa_sql_livre_archguard', () => {
  const definitions = path.join(TOOLS_DIR, 'definitions');
  assert.ok(fs.existsSync(definitions), 'a pasta tools/definitions existe');
  const arquivos = listar(TOOLS_DIR).filter((f) => f.endsWith('.js'));
  assert.ok(arquivos.length >= 15);
  // O guarda de arquitetura real não acha violação em tools/.
  assert.deepEqual(varrer().filter((v) => v.arquivo.includes(`${path.sep}tools${path.sep}`)), []);
  // Nenhuma definição de tool importa models, sequelize ou conexão; só serviços via ctx.
  for (const f of listar(definitions).filter((a) => a.endsWith('.js'))) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/require\(['"][^'"]*\/models(?:\/[^'"]*)?['"]\)/.test(src), `${f} importa models`);
    assert.ok(!/sequelize/i.test(src), `${f} cita sequelize`);
    assert.ok(!/\.query\s*\(/.test(src), `${f} usa query`);
  }
  // E a prova negativa: uma tool que chamasse SQL livre seria reprovada pelo mesmo guarda.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d016-'));
  fs.mkdirSync(path.join(tmp, 'tools', 'definitions'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'tools', 'definitions', 'ruim.js'), "module.exports = { execute: (ctx) => ctx.sequelize.query('SELECT 1') };\n");
  assert.equal(varrer(tmp).filter((v) => v.regra === 'sql-livre').length, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});
