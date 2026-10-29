'use strict';

/**
 * M9-D045 — o que o portão de saída de cada sprint exige além de "todas as demandas verificadas" (coluna "Portão de saída" da tabela do
 * livro e a "Correção da auditoria cega" da M9-D045). Testes por título vêm dos manifestos (M9-D043 e M9-D042) quando o livro diz "os 15
 * adversariais" ou "os 11 testes primeiro", para a lista não ser copiada à mão.
 */
const path = require('node:path');
const fs = require('node:fs');

const RAIZ = path.join(__dirname, '..', '..', '..');
const lerJson = (rel) => JSON.parse(fs.readFileSync(path.join(RAIZ, rel), 'utf8'));
const porNome = (nomes) => nomes.map((nome) => ({ nome }));

const testesPrimeiro = () => lerJson('test/ai/testes-primeiro.manifest.json').testes;
const adversariais = () => lerJson('test/marco9/ia/adversarial/adversarial.manifest.json').testes;

/** Nomes dos testes primeiro dos itens do Guia §14 (um item pode ter mais de um teste). */
const testesPrimeiroDos = (itens) => testesPrimeiro().filter((t) => itens.includes(t.item)).map((t) => t.nome);

const ARCH_GUARD = { rotulo: 'archGuard verde (scripts/ai-arch-guard.js)', argv: ['node', 'scripts/ai-arch-guard.js'] };

/** Cada sprint: { testes: [{nome}|{arquivos}], comandos: [{rotulo, argv}], verificacoes: ['piloto'] }. */
function exigenciasDoSprint(codigo) {
  switch (codigo) {
    case 'AI1': return { testes: [{ arquivos: ['test/marco9/ia/m9d010.contrato.test.js', 'test/marco9/ia/m9d011.sandbox.test.js', 'test/ai/m9d005.*.test.js', 'test/marco9/ia/m9d029.*.test.js'] }], comandos: [ARCH_GUARD], verificacoes: [] };
    case 'AI2': return { testes: [...porNome(testesPrimeiroDos([3, 4, 2, 11, 8])), { arquivos: ['test/marco9/ia/m9d034.*.test.js'] }], comandos: [], verificacoes: ['piloto'] };
    case 'AI3': return { testes: [{ arquivos: ['test/marco9/ia/m9d022.*.test.js', 'test/marco9/ia/m9d023.*.test.js'] }], comandos: [], verificacoes: [] };
    case 'AI4': return { testes: porNome(['m9d025_resposta_factual_exige_fonte_e_snapshot', 'm9d025_divergencia_listada_com_versoes', 'm9d026_numero_sem_origem_rejeitado', 'adv_fonte_revogada_nao_usada_como_vigente']), comandos: [], verificacoes: [] };
    case 'AI5': return { testes: [{ arquivos: ['test/marco9/ia/m9d009.*.test.js'] }, ...porNome(adversariais().filter((t) => t.ordem === 11).map((t) => t.nome))], comandos: [], verificacoes: [] };
    case 'AI6': return { testes: [...porNome(['m9d019_aprovador_distinto', 'm9d019_snapshot_mudou_409_e_vira_stale', 'm9d019_execucao_idempotente_duas_conexoes']), { arquivos: ['test/marco9/ia/m9d031.*.test.js', 'test/marco9/ia/m9d032.*.test.js'] }], comandos: [], verificacoes: [] };
    case 'AI7': return { testes: porNome(['m9d012_decisao_deterministica', 'm9d013_fallback_seguro', 'm9d014_alerta_50_75_90_100_uma_vez_cada', 'm9d015_cache_nao_guarda_confidential_nem_restricted']), comandos: [], verificacoes: [] };
    case 'AI8': return { testes: [...porNome(adversariais().map((t) => t.nome)), ...porNome(testesPrimeiro().map((t) => t.nome)), { arquivos: ['test/marco9/ia/m9d044.esteira.test.js', 'test/marco9/ia/m9d044.portoes.test.js'] }], comandos: [], verificacoes: [] };
    case 'AI9': return { testes: [{ arquivos: ['test/marco9/ia/m9d044.golden_agentes.test.js'] }], comandos: [], verificacoes: [] };
    case 'AI10': return { testes: [{ arquivos: ['test/marco9/ia/m9d046.*.test.js'] }], comandos: [], verificacoes: [] };
    default: return { testes: [], comandos: [], verificacoes: [] };
  }
}

module.exports = { exigenciasDoSprint, testesPrimeiroDos, RAIZ };
