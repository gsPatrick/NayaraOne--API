'use strict';

/**
 * M9-D914 §3 — o que a migração v2 mede e exporta, e quem responde por cada entidade. As sete métricas são as da Torre de controle (M9-D901); os dois relatórios são os da
 * reconciliação (M9-D905) e do descarte (M9-D911). `readModel` diz de qual tabela da Torre o número sai (a mesma que o aplicador da M9-D900 alimenta pelo evento do lote).
 */
const EVENT_CODE = 'migration.batch.applied';
const OWNER = 'TECNOLOGIA';

const READ_MODELS = Object.freeze({
  RECORDS: { code: 'governance.mig_records', description: 'Registro de origem da migração: uma linha por chave do legado, com estado (migrado, quarentena, em revisão, reconciliado, excluído) e conteúdo de origem; base dos contadores da Torre de controle.' },
  BATCHES: { code: 'governance.mig_batches', description: 'Lotes da migração: início, fim, linhas e estado de cada lote aplicado; base da vazão e da estimativa de término da Torre de controle.' },
  BLOCKERS: { code: 'governance.mig_blockers', description: 'Blockers abertos da migração (quarentena, revisão, reconciliação pendente, lote não verificado, relógio, comparação paralela); base do painel de corte.' },
});

const METRICS = Object.freeze([
  { code: 'MIG_TOTAL', readModel: 'RECORDS', description: 'Total de registros da origem trazidos pela migração (soma de todos os estados), no total e por entidade.', transformation: 'contagem de registros' },
  { code: 'MIG_MIGRATED', readModel: 'RECORDS', description: 'Registros já gravados no Nayara (estado migrado ou reconciliado).', transformation: 'contagem por estado MIGRATED e RECONCILED' },
  { code: 'MIG_QUARANTINED', readModel: 'RECORDS', description: 'Registros em quarentena: o dado do legado não passou na validação e espera correção humana.', transformation: 'contagem por estado QUARANTINED' },
  { code: 'MIG_PENDING_REVIEW', readModel: 'RECORDS', description: 'Registros esperando decisão humana (possível duplicata ou dúvida da carga).', transformation: 'contagem por estado PENDING_REVIEW' },
  { code: 'MIG_RECONCILED', readModel: 'RECORDS', description: 'Registros reconciliados: o lote foi verificado contra a origem (raiz de integridade igual) e o registro foi confirmado.', transformation: 'contagem por estado RECONCILED' },
  { code: 'MIG_ETA', readModel: 'BATCHES', description: 'Estimativa de término da carga: registros ainda não iniciados divididos pela vazão média dos últimos lotes concluídos.', transformation: 'registros restantes / linhas por minuto dos últimos lotes' },
  { code: 'MIG_BLOCKERS', readModel: 'BLOCKERS', description: 'Condições abertas que impedem o corte, cada uma com dono e data de abertura.', transformation: 'lista dos blockers abertos' },
]);

const EXPORTS = Object.freeze([
  { code: 'EXPORT_MIG_RECONCILIATION', readModel: 'RECORDS', description: 'Relatório de reconciliação da migração: por entidade, o que foi migrado, reconciliado, em quarentena, em revisão e excluído, com a raiz de integridade de cada lote.', transformation: 'o relatório é montado das linhas do registro de origem' },
  { code: 'EXPORT_MIG_DISPOSAL', readModel: 'RECORDS', description: 'Relatório de descarte da migração: o que do legado foi eliminado ou anonimizado ao fim do prazo, com o registro de origem de cada item.', transformation: 'o relatório é montado das linhas do registro de origem' },
]);

/** Domínio de dados mestres (M9-D804) do steward de cada entidade migrada; a entidade fora desta lista não entra no mapa. */
const ENTITY_DOMAIN = Object.freeze({
  PERSON: 'PESSOAS', PROPERTY: 'IMOVEIS', SUPPLIER: 'FORNECEDORES', CONTRACT: 'CONTRATOS', FINANCIAL_ENTRY: 'FINANCEIRO', INSTALLMENT: 'FINANCEIRO',
  COMMISSION: 'COMISSOES', PROJECT: 'OBRAS', STOCK_ITEM: 'ESTOQUE', CORRESPONDENT_CASE: 'CORRESPONDENTE',
});

module.exports = { EVENT_CODE, OWNER, READ_MODELS, METRICS, EXPORTS, ENTITY_DOMAIN };
