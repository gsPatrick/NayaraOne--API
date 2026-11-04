#!/usr/bin/env node
'use strict';

/** M9-D705 etapa 2 — compila (sintaxe e JSX) as telas e o cliente de API do BI no Front. Sai com 1 e lista arquivo:linha em caso de erro. */
const { verificarSintaxe } = require('./gates/sintaxeFront');

const r = verificarSintaxe();
if (!r.ok) {
  r.problemas.forEach((p) => console.error(`Erro de tipo/sintaxe: ${p}`));
  process.exit(1);
}
if (r.verificados === 0) {
  // Sem o Front ao lado nada foi compilado: não é "aprovada". O CI que declara a ausência (CI_SEM_REPOS_IRMAOS=1) registra NAO_APLICAVEL_NO_CI de forma visível; senão reprova.
  const sem = process.env.CI_SEM_REPOS_IRMAOS === '1';
  console.error(`${sem ? 'NAO_APLICAVEL_NO_CI' : 'Erro'}: nenhum arquivo de BI do Front foi encontrado (NayaraOne--FRONT ausente ao lado da API); nada foi compilado.`);
  process.exit(sem ? 0 : 1);
}
console.log(`OK: ${r.verificados} arquivo(s) de BI do Front sem erro de compilação.`);
