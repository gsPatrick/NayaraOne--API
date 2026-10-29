'use strict';

/**
 * M9-D046 — executor dos failure drills da NAY. Cada cenário (scripts/ai-drill/cenarios/*.js) exporta { id, letra, titulo, esperado,
 * executar({ F, tenantA, tenantB, relatorio }) }. O executor monta as duas empresas do banco descartável, roda o cenário com o provider
 * sandbox e devolve o registro { drill, ..., ok, checagens, executadoEm }. Recusa rodar fora de banco descartável (DISPOSABLE_DB=1).
 * Uso pelo script de cada drill: `node scripts/withDisposableDb.js -- bash -c "node scripts/seed-ci-two-tenants.js && node scripts/ai-drill-<nome>.js"`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Relatorio } = require('./relatorio');

const PASTA_REGISTRO = path.join(__dirname, '..', '..', '..', 'docs', 'evidencias', 'ai', 'drills');

function exigirBancoDescartavel(env = process.env) {
  if (env.DISPOSABLE_DB !== '1') {
    throw new Error('Os failure drills da NAY só rodam em banco descartável (node scripts/withDisposableDb.js -- ...): nunca contra a homologação.');
  }
}

/** Roda o cenário e devolve o registro. Exceção do cenário vira checagem vermelha. */
async function executarCenario(cenario, ambiente) {
  const relatorio = new Relatorio();
  try {
    await cenario.executar({ ...ambiente, relatorio });
  } catch (err) {
    relatorio.confere('o cenário terminou sem exceção', false, err && err.message);
  }
  return {
    drill: cenario.id, letra: cenario.letra, titulo: cenario.titulo, esperado: cenario.esperado, ambiente: 'LAB', provider: 'ai-sandbox',
    executadoEm: new Date().toISOString(), ok: relatorio.ok, checagens: relatorio.checagens,
  };
}

function gravarRegistro(registro, pasta = PASTA_REGISTRO) {
  fs.mkdirSync(pasta, { recursive: true });
  const arquivo = path.join(pasta, `${registro.drill}-${registro.executadoEm.slice(0, 10)}.json`);
  fs.writeFileSync(arquivo, `${JSON.stringify(registro, null, 2)}\n`);
  return arquivo;
}

/** Ponto de entrada dos scripts `scripts/ai-drill-*.js`: executa, imprime o registro, grava em docs/evidencias/ai/drills e sai 0 só se verde. */
async function main(cenario, { pasta } = {}) {
  exigirBancoDescartavel();
  const F = require('../../../test/marco9/_helpers/advFixtures');
  let registro;
  try {
    const { tenantA, tenantB } = await F.empresas();
    registro = await executarCenario(cenario, { F, tenantA, tenantB });
  } finally {
    await F.sequelize.close();
  }
  const arquivo = gravarRegistro(registro, pasta);
  console.log(JSON.stringify({ ...registro, registro: path.relative(process.cwd(), arquivo) }, null, 2));
  process.exitCode = registro.ok ? 0 : 1;
}

module.exports = { main, executarCenario, gravarRegistro, exigirBancoDescartavel, PASTA_REGISTRO };
