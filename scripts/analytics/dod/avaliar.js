'use strict';

/**
 * M9-D707 — avalia os itens do DoD. Cada item é SIM só se: (1) todas as suas demandas estão `verificada` e válidas para o `demandas-check.js`
 * (verificador independente); (2) os testes dele rodam verdes (exit 0, nenhum pulado, nomes exigidos verdes); (3) as etapas da esteira exigidas
 * estão APROVADAS; (4) os scripts sem banco saem com 0. O executor de comandos e o verificador de demanda são injetados.
 */
const { nomeVerde, adversariaisVerdes, resumoDaSaida, problemasEstaticos } = require('./testes');
const { avaliarEsteira } = require('../sprints/esteira');

async function provaDasDemandas(item, demandas, verificar) {
  const motivos = [];
  for (const id of item.demandas) {
    const d = demandas.get(id);
    if (!d) { motivos.push(`${id}: demanda sem arquivo`); continue; }
    if (d.status !== 'verificada') { motivos.push(`${id}: status ${d.status || '(vazio)'}, precisa estar verificada`); continue; }
    const r = await verificar(d);
    if (!r.ok) motivos.push(`${id}: verificada sem registro válido (${r.motivo})`);
  }
  return motivos;
}

/** Nome do primeiro teste vermelho da saída, para o motivo apontar onde olhar. */
function primeiroVermelho(saida) {
  const m = String(saida).match(/^\s*(?:✖|not ok \d+ -)\s+(?!.*\.test\.js)(.+?)(?:\s+\([\d.]+ms\))?$/m);
  return m ? ` — primeiro vermelho: ${m[1].slice(0, 140)}` : '';
}

async function provaDosTestes(item, executar) {
  const motivos = [];
  for (const g of item.testes) {
    const r = await executar({ cmd: 'node', args: ['--test', '--test-concurrency=1', ...g.arquivos], banco: true });
    const resumo = resumoDaSaida(r.output);
    if (r.code !== 0 || resumo.falhos > 0) motivos.push(`teste vermelho em ${g.arquivos.join(', ')}${primeiroVermelho(r.output)}`);
    else if (resumo.pulados > 0) motivos.push(`${resumo.pulados} teste(s) pulado(s) em ${g.arquivos.join(', ')}`);
    else if (!resumo.passou) motivos.push(`nenhum teste rodou em ${g.arquivos.join(', ')}`);
    for (const nome of g.nomes || []) if (r.code === 0 && !nomeVerde(r.output, nome)) motivos.push(`o teste "${nome}" não aparece verde`);
    if (item.quinze && r.code === 0) {
      const verdes = adversariaisVerdes(r.output);
      if (verdes.length !== 15) motivos.push(`os 15 testes adversariais: ${verdes.length} verdes (${verdes.join(',') || 'nenhum'})`);
    }
  }
  return motivos;
}

async function provaDosComandos(item, executar) {
  const motivos = [];
  for (const [cmd, ...args] of item.comandos || []) {
    const r = await executar({ cmd, args, banco: false });
    if (r.code !== 0) motivos.push(`${cmd} ${args.join(' ')} saiu com ${r.code}`);
  }
  return motivos;
}

async function avaliarItem(item, { demandas, verificar, executar, esteira, raiz }) {
  const motivos = [...problemasEstaticos(raiz, item), ...(await provaDasDemandas(item, demandas, verificar))];
  if (item.etapasCi) {
    const r = avaliarEsteira({ ...esteira, etapas: item.etapasCi });
    motivos.push(...r.motivos);
  }
  if (!motivos.length) motivos.push(...(await provaDosTestes(item, executar)), ...(await provaDosComandos(item, executar)));
  return { n: item.n, chave: item.chave, livro: item.livro, ok: motivos.length === 0, motivos };
}

async function avaliarDod(itens, contexto) {
  const resultado = [];
  for (const item of itens) resultado.push(await avaliarItem(item, contexto));
  return { ok: resultado.every((r) => r.ok), itens: resultado };
}

module.exports = { avaliarDod, avaliarItem };
