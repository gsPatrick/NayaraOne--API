'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RAIZ = path.resolve(__dirname, '../../..');
const ENTRADAS = [
  'src/features/ai',
  'src/features/ai/agents',
  'src/features/ai/agents/kit',
  'src/features/ai/agents/kit/definitions',
  'src/features/ai/agents/nay_atendimento',
  'src/features/ai/agents/nay_atendimento/provision',
  'src/features/ai/agents/nay_correspondente',
];

/** Carrega a lista pelo caminho de require dado, num processo novo (a ordem de carga é o que cria o ciclo). */
function listaPor(entrada) {
  const codigo = `
    require(${JSON.stringify(path.join(RAIZ, entrada))});
    const { SYSTEM_AGENT_DEFINITIONS } = require(${JSON.stringify(path.join(RAIZ, 'src/features/ai/agents/kit/definitions'))});
    process.stdout.write(JSON.stringify(SYSTEM_AGENT_DEFINITIONS.map((d) => d && d.code)));
  `;
  return JSON.parse(execFileSync(process.execPath, ['-e', codigo], { cwd: RAIZ, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
}

test('m9d041_lista_de_agentes_do_sistema_e_a_mesma_por_qualquer_caminho_de_require', () => {
  const referencia = listaPor('src/features/ai/agents/kit/definitions');
  assert.ok(referencia.includes('NAY_ATENDIMENTO'), 'NAY_ATENDIMENTO está na lista');
  assert.ok(referencia.every((c) => typeof c === 'string' && c.startsWith('NAY_')), 'nenhuma posição indefinida');
  for (const entrada of ENTRADAS) assert.deepEqual(listaPor(entrada), referencia, `lista diferente por ${entrada}`);
});
