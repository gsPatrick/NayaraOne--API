'use strict';

/**
 * M9-D653 — KPI inv.tools_overdue (Ferramentas emprestadas em atraso e patrimônio em manutenção), versão 1. Valor = empréstimos abertos com devolução
 * prevista anterior à data-base (calendário de São Paulo); dimensões: empréstimos abertos e patrimônios com ordem de manutenção aberta. A lista de quem
 * está com o quê vai ao drill-down. Posição, natureza ACTUAL. Entrada (rm_tool_assets): { overdue, open, inMaintenance, withoutDueDate }. Regra de
 * qualidade: empréstimo aberto sem data prevista -> DEGRADED, sem valor. Responsável e categoria de ferramenta ficam no detalhe (DI-D653-2).
 */
const money = require('./money');
const { degraded } = require('./_obraEstoqueKpi');

function compute(input) {
  const withoutDueDate = money.count(input.withoutDueDate || 0);
  const open = money.count(input.open || 0);
  const maintenance = money.count(input.inMaintenance || 0);
  const details = { open, inMaintenance: maintenance, withoutDueDate };
  const dimensions = [{ key: 'abertos_qtd', value: open }, { key: 'manutencao_qtd', value: maintenance }, { key: 'sem_data_qtd', value: withoutDueDate }];
  if (withoutDueDate !== '0') return degraded('EMPRESTIMO_SEM_DATA_PREVISTA', details, dimensions);
  return { value: money.count(input.overdue || 0), status: 'OK', details, dimensions };
}

const okOf = (value, open, maintenance) => ({ value, status: 'OK', details: { open, inMaintenance: maintenance, withoutDueDate: '0' }, dimensions: [{ key: 'abertos_qtd', value: open }, { key: 'manutencao_qtd', value: maintenance }, { key: 'sem_data_qtd', value: '0' }] });

const testCases = [
  { kind: 'empty', name: 'nenhum empréstimo aberto', input: { overdue: 0, open: 0, inMaintenance: 0, withoutDueDate: 0 }, expected: okOf('0', '0', '0') },
  { kind: 'single', name: 'um empréstimo em atraso', input: { overdue: 1, open: 1, inMaintenance: 0, withoutDueDate: 0 }, expected: okOf('1', '1', '0') },
  { kind: 'typical', name: 'exemplo do livro: 4 em atraso de 17 abertos; 3 ativos em manutenção', input: { overdue: 4, open: 17, inMaintenance: 3, withoutDueDate: 0 }, expected: okOf('4', '17', '3') },
  {
    kind: 'period_edge', name: 'empréstimo aberto sem data prevista: DEGRADED e sem valor', input: { overdue: 4, open: 17, inMaintenance: 3, withoutDueDate: 2 },
    expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'EMPRESTIMO_SEM_DATA_PREVISTA', open: '17', inMaintenance: '3', withoutDueDate: '2' }, dimensions: [{ key: 'abertos_qtd', value: '17' }, { key: 'manutencao_qtd', value: '3' }, { key: 'sem_data_qtd', value: '2' }] },
  },
  { kind: 'rounding', name: 'contagem vinda do banco como texto continua inteira', input: { overdue: '4', open: '17', inMaintenance: '3', withoutDueDate: '0' }, expected: okOf('4', '17', '3') },
];

module.exports = { id: 'inv.tools_overdue', version: 1, compute, testCases };
