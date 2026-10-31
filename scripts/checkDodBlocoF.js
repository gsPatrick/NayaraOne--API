#!/usr/bin/env node
'use strict';

/**
 * Fechamento do bloco F (M9-D940): o ÚNICO comando que confere o DoD do livro (Migração v2 DRY3, governance registry, lineage crítico, DLP, manifest documental) e os nove testes
 * nomeados do bloco. Uma linha por item (OK ou FALHA <motivo>); o registro da execução (data, commit, itens) vai para docs/evidencias/ci/dod-bloco-f.json.
 *   node scripts/checkDodBlocoF.js [--config <arq>] [--saida <arq>] [--itens dry3,registry,lineage,dlp,manifest,adversarial]
 * Saída: 0 só com todos OK; 1 com item reprovado (GOV_DOD_F_ITEM_FAILED); 2 se algo não pôde ser lido ou verificado (GOV_DOD_F_INVALID). Com --itens a execução é PARCIAL: não é o
 * fechamento e não grava o registro. Registry e DLP rodam em banco descartável (sobe sozinho; nunca o compartilhado). Banco local já pronto: DISPOSABLE_DB=1 e DATABASE_ADMIN_URL.
 */
const path = require('node:path');
const { lerConfig, daRaiz, CONFIG_PADRAO } = require('./governance-ci/dodF/config');
const { LeituraError, CODIGO_INVALIDO, MENSAGEM_INVALIDO } = require('./governance-ci/dodF/erros');
const { executar, linhas, mensagensDeErro, ITENS } = require('./governance-ci/dodF');
const { gravar } = require('./governance-ci/dodF/registro');
const { reexecutarEmBancoDescartavel, informarStatus } = require('./governance-ci/dodF/banco');

function opcoes(argv) {
  const o = { config: CONFIG_PADRAO, saida: null, itens: null };
  for (let i = 0; i < argv.length; i += 2) {
    const chave = argv[i];
    if (!['--config', '--saida', '--itens'].includes(chave) || argv[i + 1] === undefined) throw new LeituraError(`uso: node scripts/checkDodBlocoF.js [--config <arq>] [--saida <arq>] [--itens <lista>] (opção inválida: ${chave})`);
    if (chave === '--config') o.config = path.resolve(argv[i + 1]);
    else if (chave === '--saida') o.saida = path.resolve(argv[i + 1]);
    else o.itens = argv[i + 1].split(',').map((s) => s.trim());
  }
  if (o.itens && (!o.itens.length || o.itens.some((c) => !ITENS[c]))) throw new LeituraError(`--itens aceita ${Object.keys(ITENS).join(', ')}`);
  return o;
}

async function main(argv) {
  const o = opcoes(argv);
  const chaves = o.itens || Object.keys(ITENS);
  if (chaves.some((c) => ITENS[c].precisaBanco) && process.env.DISPOSABLE_DB !== '1') return reexecutarEmBancoDescartavel(argv);
  const cfg = lerConfig(o.config);
  const r = await executar({ cfg, chaves });
  linhas(r.resultados).forEach((l) => console.log(l));
  mensagensDeErro(r.resultados).forEach((l) => console.error(l));
  if (o.itens) { console.log(`PARCIAL: ${chaves.join(', ')}. Isto não é o fechamento do bloco F.`); return r.codigo; }
  const registro = gravar(o.saida || daRaiz(cfg.saida), r);
  console.log(`Fechamento do bloco F: ${registro.resultado} em ${registro.generated_at} (commit ${registro.commit.slice(0, 8)}).`);
  return r.codigo;
}

main(process.argv.slice(2)).then((codigo) => { informarStatus(codigo); process.exit(codigo); }, (e) => {
  console.error(`${CODIGO_INVALIDO}: ${MENSAGEM_INVALIDO}`);
  console.error(`  ${e instanceof LeituraError ? e.message : (e.code || e.message)}`);
  informarStatus(2);
  process.exit(2);
});
