'use strict';

/** M9-D707 — executor e verificador falsos para o DoD: tudo verde por padrão; `falhar(comando)` e `saida(comando)` mudam um caso. */
const { ITENS } = require('../../../scripts/analytics/dod/itens');

const NOMES = ITENS.flatMap((i) => i.testes.flatMap((g) => g.nomes || []));
const QUINZE = Array.from({ length: 15 }, (_, k) => `m9d704 adv${String(k + 1).padStart(2, '0')} caso`);
const RESUMO = 'ℹ tests 3\nℹ pass 3\nℹ fail 0\nℹ skipped 0\nℹ todo 0\n';

const saidaVerde = () => `${[...NOMES, ...QUINZE].map((n) => `✔ ${n} (1ms)`).join('\n')}\n${RESUMO}`;

function executorFalso({ falhar = () => false, saida = () => null } = {}) {
  const chamadas = [];
  const executar = async (comando) => {
    chamadas.push(comando);
    if (falhar(comando)) return { code: 1, output: `✖ quebrou\n${RESUMO.replace('fail 0', 'fail 1')}` };
    return { code: 0, output: saida(comando) ?? saidaVerde() };
  };
  return { executar, chamadas };
}

const verificarVerde = async () => ({ ok: true });

module.exports = { executorFalso, verificarVerde, saidaVerde, RESUMO, QUINZE };
