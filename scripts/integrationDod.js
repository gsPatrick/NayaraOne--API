#!/usr/bin/env node
'use strict';

/**
 * integrationDod (M9-D253, livro seção 20 e Guia §14): o Definition of Done do bloco de integrações como portão objetivo. Confere os 15 itens com a evidência de cada um
 * e a matriz docs/integrations/MATRIZ_INT.md (15 princípios, demanda dona, teste existente). Roda na etapa 9 da esteira (scripts/int-ci/estagios.json), depois das etapas 3 a 8.
 * Uso: node scripts/integrationDod.js [--raiz <pasta>]    |    node scripts/integrationDod.js --gerar-matriz
 * Saída 0 só com tudo presente; item sem evidência imprime INTEGRATION_DOD_ITEM_MISSING e sai com 1. Somente leitura (exceto --gerar-matriz), sem banco, sem segredo.
 */
const fs = require('node:fs');
const path = require('node:path');
const { ITENS } = require('./int-ci/lib/dodItens');
const { executar } = require('./int-ci/lib/dod');
const { ambienteReal } = require('./int-ci/lib/dodAmbiente');
const { renderMatriz } = require('./int-ci/lib/matrizInt');

const argv = process.argv.slice(2);
const i = argv.indexOf('--raiz');
const raiz = i >= 0 ? path.resolve(argv[i + 1]) : path.resolve(__dirname, '..');
const arquivoMatriz = path.join(raiz, 'docs/integrations/MATRIZ_INT.md');

if (argv.includes('--gerar-matriz')) {
  fs.mkdirSync(path.dirname(arquivoMatriz), { recursive: true });
  fs.writeFileSync(arquivoMatriz, renderMatriz());
  console.log('docs/integrations/MATRIZ_INT.md gerado.');
  process.exit(0);
}

const md = fs.existsSync(arquivoMatriz) ? fs.readFileSync(arquivoMatriz, 'utf8') : '';
const r = executar(ITENS, ambienteReal(raiz), md);
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exit(r.code);
