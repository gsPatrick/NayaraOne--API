'use strict';

// M9-D704 — os 15 testes adversariais do BI (Caderno §21), um teste nomeado cada. Nenhum tem lógica própria: cada um executa o(s) teste(s) da
// demanda que implementa a regra (tabela 3.1) em um processo separado e exige verde, sem pulado. Se a proteção for removida, o teste da dona
// falha e este falha junto (mutação documentada em docs/evidencias/analytics/mutacoes-adversariais.json). Os nomes abaixo são fixos.
const { test } = require('node:test');
const { exigirVerde } = require('../_helpers/m9d704Executa');

test('m9d704 adv01 caixa livre nao inclui caucao', () => exigirVerde(1));
test('m9d704 adv02 detalhe de outra empresa e bloqueado', () => exigirVerde(2));
test('m9d704 adv03 snapshot antigo gera freshness e alerta', () => exigirVerde(3));
test('m9d704 adv04 formula alterada exige nova versao', () => exigirVerde(4));
test('m9d704 adv05 replay de evento nao duplica read model', () => exigirVerde(5));
test('m9d704 adv06 alerta repetido respeita cooldown', () => exigirVerde(6));
test('m9d704 adv07 drilldown sem permissao e bloqueado', () => exigirVerde(7));
test('m9d704 adv08 export massivo exige MFA e gera auditoria', () => exigirVerde(8));
test('m9d704 adv09 nay inventa causa e o grounding bloqueia', () => exigirVerde(9));
test('m9d704 adv10 falha de qualidade marca kpi degraded', () => exigirVerde(10));
test('m9d704 adv11 intercompany eliminado na leitura', () => exigirVerde(11));
test('m9d704 adv12 dashboard pesado nao degrada oltp', () => exigirVerde(12));
test('m9d704 adv13 rebuild reproduz o resultado', () => exigirVerde(13));
test('m9d704 adv14 timezone de periodo correto', () => exigirVerde(14));
test('m9d704 adv15 arredondamento financeiro consistente', () => exigirVerde(15));
