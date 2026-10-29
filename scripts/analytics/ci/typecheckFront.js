#!/usr/bin/env node
'use strict';

/** M9-D705 etapa 2 — compila (sintaxe e JSX) as telas e o cliente de API do BI no Front. Sai com 1 e lista arquivo:linha em caso de erro. */
const { verificarSintaxe } = require('./gates/sintaxeFront');

const r = verificarSintaxe();
if (!r.ok) {
  r.problemas.forEach((p) => console.error(`Erro de tipo/sintaxe: ${p}`));
  process.exit(1);
}
console.log(`OK: ${r.verificados} arquivo(s) de BI do Front sem erro de compilação.`);
