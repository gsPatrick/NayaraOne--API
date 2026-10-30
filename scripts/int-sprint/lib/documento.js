'use strict';

/** M9-D255 — gera docs/integrations/SPRINTS.md a partir do mapa lido da demanda (nunca à mão): o teste exige o arquivo igual ao gerado. */
const { ordemDeExecucao } = require('./avaliar');

const curto = (id) => id.replace('M9-', '');

function gerarDocumento(mapa, demandas) {
  const linhas = [
    '# Ordem de implementação e sprints das integrações (M9-D255)', '',
    'Arquivo GERADO por `node scripts/integrationSprintGate.js --gerar-doc` a partir da tabela da demanda M9-D255. Não edite à mão: o teste `sprints_documento_atualizado` compara.', '',
    '## Passos do livro para demandas', '', '| Passo | Conteúdo | Demandas |', '|---|---|---|',
    ...mapa.passos.map((p) => `| ${p.n} | ${p.nome} | ${p.demandas.map(curto).join(', ')} |`), '',
    `Transversais de segurança e administração: ${mapa.transversais.map(curto).join(', ')}.`, '',
    '## Sprints', '', '| Sprint | Escopo | Demandas (ordem de execução) | Portão de saída |', '|---|---|---|---|',
    ...mapa.sprints.map((s) => `| ${s.codigo} | ${s.tema} | ${ordemDeExecucao(mapa, demandas, s.codigo).ordem.map(curto).join(', ')} | ${s.portao} |`), '',
    '## Como conferir', '',
    '- `node scripts/integrationSprintGate.js` mostra o painel e reprova cobertura quebrada, passo sem demanda e dependência que contraria a ordem.',
    '- `node scripts/integrationSprintGate.js --sprint I3 [--executar]` avalia o portão de saída (demandas verificadas, testes e comandos); `--executar` só em banco descartável.',
    '- `node scripts/withDisposableDb.js -- bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && node scripts/loadTestIntegrations.js"` roda a carga do I9 (volume nos parâmetros `integration.load.*`).', '',
  ];
  return linhas.join('\n');
}

module.exports = { gerarDocumento };
