'use strict';

// M9-D704 — mapa dos 15 testes adversariais do Caderno §21 (tabela 3.1) e dos 10 "testes primeiro" do Guia (tabela 3.3): cada item aponta o
// teste nomeado da demanda dona. Os nomes dos testes adversariais são fixos; mudar um exige revisar a demanda M9-D704.
const D = 'test/marco9/analytics';
const t = (dona, arquivo, nome) => ({ dona, arquivo: `${D}/${arquivo}`, nome });

const ADVERSARIAIS = [
  { n: 1, nome: 'm9d704 adv01 caixa livre nao inclui caucao', livro: 'KPI caixa inclui caução → teste deve falhar', testes: [t('M9-D620', 'm9d620.caixaLivre.test.js', 'm9d620 freeCash exclui caução e fundos de terceiros')] },
  { n: 2, nome: 'm9d704 adv02 detalhe de outra empresa e bloqueado', livro: 'Cross-company detail → bloqueado', testes: [t('M9-D690', 'm9d690.escopo.test.js', 'm9d690 cross-company detail é bloqueado com 404')] },
  { n: 3, nome: 'm9d704 adv03 snapshot antigo gera freshness e alerta', livro: 'Snapshot antigo exibido como atual → freshness alerta', testes: [
    t('M9-D609', 'm9d609.alerta.test.js', 'm9d609 snapshot antigo exibido como atual dispara alerta de freshness'),
    t('M9-D609', 'm9d609.freshness.test.js', 'm9d609 freshness correta: FRESH, STALE e EXPIRED nos limites exatos')] },
  { n: 4, nome: 'm9d704 adv04 formula alterada exige nova versao', livro: 'Fórmula alterada → nova versão', testes: [
    t('M9-D604', '../../analytics.m9d604.test.js', 'm9d604 fórmula alterada cria nova versão e nunca altera a anterior'),
    t('M9-D604', '../../analytics.m9d604.test.js', 'm9d604 edição direta de campo numérico é recusada')] },
  { n: 5, nome: 'm9d704 adv05 replay de evento nao duplica read model', livro: 'Read model duplicado por evento replay → idempotente', testes: [
    t('M9-D607', 'm9d607.worker.test.js', 'm9d607 read model duplicado por evento replay é idempotente'),
    t('M9-D607', 'm9d607.worker.test.js', 'm9d607 replay concorrente em 2 conexões aplica uma vez')] },
  { n: 6, nome: 'm9d704 adv06 alerta repetido respeita cooldown', livro: 'Alerta repetido → cooldown', testes: [t('M9-D691', 'm9d691.ciclo.test.js', 'm9d691 alerta repetido respeita cooldown e não duplica')] },
  { n: 7, nome: 'm9d704 adv07 drilldown sem permissao e bloqueado', livro: 'Drill-down sem permissão → bloqueado', testes: [t('M9-D690', 'm9d690.escopo.test.js', 'm9d690 drill-down sem permissão é bloqueado e devolve só o agregado')] },
  { n: 8, nome: 'm9d704 adv08 export massivo exige MFA e gera auditoria', livro: 'Export massivo → audit/MFA', testes: [t('M9-D701', 'm9d701.pedido.test.js', 'm9d701 export massivo exige MFA e gera auditoria')] },
  { n: 9, nome: 'm9d704 adv09 nay inventa causa e o grounding bloqueia', livro: 'NAY inventa causa → grounding bloqueia', testes: [t('M9-D694', 'm9d694.bloqueio.test.js', 'm9d694 NAY inventa causa e o grounding bloqueia')] },
  { n: 10, nome: 'm9d704 adv10 falha de qualidade marca kpi degraded', livro: 'Data quality falha → KPI DEGRADED', testes: [t('M9-D697', 'm9d697.estados.test.js', 'm9d697 data quality falha e o KPI fica DEGRADED sem valor')] },
  { n: 11, nome: 'm9d704 adv11 intercompany eliminado na leitura', livro: 'Consolidado soma intercompany duas vezes → eliminação na leitura', testes: [t('M9-D625', 'm9d625.eliminacao.test.js', 'm9d625 consolidado soma intercompany duas vezes é corrigido pela eliminação na leitura')] },
  { n: 12, nome: 'm9d704 adv12 dashboard pesado nao degrada oltp', livro: 'Dashboard pesado não degrada OLTP em teste de carga', testes: [t('M9-D699', 'm9d699.carga.test.js', 'm9d699 dashboard pesado não degrada OLTP em teste de carga')] },
  { n: 13, nome: 'm9d704 adv13 rebuild reproduz o resultado', livro: 'Rebuild read model reproduz resultado', testes: [t('M9-D608', 'm9d608.reproducao.test.js', 'm9d608 rebuild read model reproduz resultado do incremental')] },
  { n: 14, nome: 'm9d704 adv14 timezone de periodo correto', livro: 'Timezone de período correto', testes: [t('M9-D606', 'm9d606.periodo.test.js', 'm9d606 timezone de período correto: 23:30 SP de 30/09 pertence a setembro')] },
  { n: 15, nome: 'm9d704 adv15 arredondamento financeiro consistente', livro: 'Arredondamento financeiro consistente', testes: [
    t('M9-D605', '../../analytics.m9d605.test.js', 'm9d605 arredondamento financeiro consistente (tabela de 20 casos, positivos, negativos, half-up)'),
    t('M9-D605', '../../analytics.m9d605.test.js', 'm9d605 soma de 1000 valores de 0,01 dá 10,00 exato')] },
];

// Tabela 3.3 do Guia §11 (testes primeiro). O item 6 (cross-company/drill-down), o 7 (dataset e KPI) têm dois testes cada.
const TESTES_PRIMEIRO = [
  { item: 1, ...t('M9-D620', 'm9d620.caixaLivre.test.js', 'm9d620 freeCash exclui caução e fundos de terceiros') },
  { item: 2, ...t('M9-D625', 'm9d625.eliminacao.test.js', 'm9d625 intercompany não duplica o consolidado (receita e custo)') },
  { item: 3, ...t('M9-D607', 'm9d607.worker.test.js', 'm9d607 read model duplicado por evento replay é idempotente') },
  { item: 4, ...t('M9-D609', 'm9d609.freshness.test.js', 'm9d609 freshness correta: FRESH, STALE e EXPIRED nos limites exatos') },
  { item: 5, ...t('M9-D604', '../../analytics.m9d604.test.js', 'm9d604 versão histórica reproduz o snapshot (mesmo valor e calc_hash)') },
  { item: 6, ...t('M9-D690', 'm9d690.escopo.test.js', 'm9d690 cross-company detail é bloqueado com 404') },
  { item: 6, ...t('M9-D690', 'm9d690.escopo.test.js', 'm9d690 drill-down sem permissão é bloqueado e devolve só o agregado') },
  { item: 7, ...t('M9-D696', 'm9d696.financeiro.test.js', 'm9d696 data quality falha e marca o dataset DEGRADED') },
  { item: 7, ...t('M9-D697', 'm9d697.estados.test.js', 'm9d697 data quality falha e o KPI fica DEGRADED sem valor') },
  { item: 8, ...t('M9-D691', 'm9d691.ciclo.test.js', 'm9d691 alerta repetido respeita cooldown e não duplica') },
  { item: 9, ...t('M9-D701', 'm9d701.worker.test.js', 'm9d701 export auditado (pedido, geração, download)') },
  { item: 10, ...t('M9-D694', 'm9d694.bloqueio.test.js', 'm9d694 NAY não inventa causa quando não há registro (diz causa não identificada)') },
];

const norm = (p) => require('node:path').posix.normalize(p);
const ARQUIVOS_DA_SUITE = [...new Set(['test/marco9/analytics/m9d704.adversarial.test.js',
...ADVERSARIAIS.flatMap((a) => a.testes.map((x) => norm(x.arquivo))), ...TESTES_PRIMEIRO.map((x) => norm(x.arquivo))])];
for (const a of ADVERSARIAIS) for (const x of a.testes) x.arquivo = norm(x.arquivo);
for (const x of TESTES_PRIMEIRO) x.arquivo = norm(x.arquivo);

module.exports = { ADVERSARIAIS, TESTES_PRIMEIRO, ARQUIVOS_DA_SUITE };
