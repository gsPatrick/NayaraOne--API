# Governança — Linhagem de dados (`lineage`)

## Objetivo
Registro de linhagem: de onde vem cada KPI e cada dado crítico (campo de origem -> campo de domínio -> evento -> read model -> métrica ou exportação). Dinheiro, contratos, comissões, DIMOB, KPIs executivos e migração são obrigatórios e sempre críticos. KPI crítico sem caminho completo reprova o portão de CI (`npm run check:lineage`, M9-D811). Regras: M9-D810 (registro) e M9-D811 (portão).

### Arquivos
- `lineage.constants|errors|rules|input`: vocabulário, erros, regras de camada e criticidade, leitura dos corpos.
- `lineage.coverage.js`: cobertura pura (usada pela API e pelo portão). `lineage.gate.js`: regras do portão. `lineage.catalog.js`: catálogo de indicadores = tabela de criticidade do BI (campo `area` de cada entrada).
- `lineage.repository|service|controller|routes`: acesso ao banco e HTTP. `lineage.seed.js`: carregador de sementes. `lineage.registryFormat|registryFile.js`: formato e geração do arquivo versionado.
- `seeds/*.seed.js`: sementes (`{ code, build() -> { nodes, edges } }`), uma por área: `money`, `contract`, `commission`, `execKpi` (derivam da tabela de criticidade do BI, das especificações de origem e do registro de read models) e `dimob`. `kit/`: ajudantes das sementes. Demanda nova que cria KPI, exportação ou entidade migrada entrega o seu `*.seed.js` aqui e roda `npm run sync:lineage`; ninguém cria outro arquivo ou gerador.

## Tabelas
Schema `governance`, RLS + FORCE por grupo (`tenant_isolation` por `group_id`), GRANT ao role de runtime só se ele existir:
- `lineage_nodes`: `node_type` (SOURCE_FIELD, DOMAIN_FIELD, EVENT, READ_MODEL, METRIC, EXPORT), `code` (único por tipo no grupo), `description`, `owner_domain` (domínio de dados mestres ou `governanca.lineage.dominios_adicionais`), `criticality` (NORMAL, CRITICAL), `area` (MONEY, CONTRACT, COMMISSION, DIMOB, EXEC_KPI, MIGRATION, OTHER), `source` (SEED ou API). Área obrigatória exige CRITICAL (constraint e serviço).
- `lineage_edges`: ligação entre nós de camadas vizinhas (`transformation` é texto curto). Única por par.
- `lineage_seed_state`: hash do conjunto de sementes já aplicado ao grupo.

## Rotas e permissões
Todas com `governance:lineage:manage` e o módulo ligado:
- `GET /data-lineage`: estado do módulo e cobertura crítica do grupo (`cobertura.critical|covered|uncovered|percent`); aplica a semente na primeira leitura.
- `POST|PUT /data-lineage/nodes` (corpo `node_type`, `code`, `description`, `owner_domain`, `area`, `criticality?`) e `POST|PUT /data-lineage/edges` (`from_node`, `to_node` com `node_type` e `code`, `transformation?`). POST cria (201; 409 se existe); PUT é idempotente por tipo + código (200).
- Erros: 422 `GOV_LINEAGE_LAYER_INVALID` (pula ou volta camada), 422 `GOV_LINEAGE_OWNER_REQUIRED`, 422 `GOV_LINEAGE_DESCRIPTION_REQUIRED`, 422 `GOV_LINEAGE_AREA_REQUIRED`, 409 `GOV_LINEAGE_CRITICALITY_LOCKED`, 404 `GOV_NOT_FOUND`, 400 `GOV_DOMAIN_INVALID`, 403 `PERMISSION_DENIED`, 401 `MISSING_ACCESS_TOKEN`, 403 `GOV_MODULE_DISABLED`. Corpo de erro único com `error.traceId`.

## Eventos
Sem evento de domínio; mudanças de nó e aresta ficam na auditoria (`registrarAuditoria`, antes e depois). Os eventos que aparecem como nós do registro são os dos read models do BI e o registro de auditoria da DIMOB.

## Jobs e horários
Nenhum job. Ferramentas de CI e desenvolvimento: `scripts/syncLineageRegistry.js` (único gerador de `docs/governance/lineage-registry.json`; `npm run sync:lineage`, só em banco descartável; `-- --check` confere) e `scripts/checkLineageCoverage.js` (`npm run check:lineage`, M9-D811: exit 0 ok, 1 reprovado, 2 arquivo ilegível; roda em todo push e pull request; não existe lista de isenção).

## Parâmetros
Aba Governança em /painel/configuracoes:
- `governanca.modulos.lineage.habilitado` (padrão ligado).
- `governanca.lineage.kpis_criticos` (padrão `*`): KPIs executivos cobrados na visão de cobertura da API.
- `governanca.lineage.dominios_adicionais` (padrão `TECNOLOGIA`): domínios responsáveis aceitos além dos de `governanca.dados.dominios`.

## Decisões (ADR)
`Maturacao/demandas/decisoes-de-implementacao.md` (DI-D810-1 a 7 e DI-D811-1 e 2). K4/K5: código novo com prefixo `GOV_` e `error.traceId`. A semente MIGRATION chega com a M9-D914 pelo mesmo carregador.

## Como testar
`node scripts/withDisposableDb.js --port <porta> -- ...` com `test/marco9/governanca/m9d810.*.test.js` e `m9d811.*.test.js` (o portão e as regras puras rodam sem banco). Nunca contra o banco do `.env`.

## Como diagnosticar
- `npm run check:lineage` lista `GOV_LINEAGE_UNCOVERED` por indicador (com a área) e os nós sem responsável ou descrição; corrija a semente do indicador e rode `npm run sync:lineage`.
- Arquivo do registro diferente das sementes: `npm run sync:lineage -- --check` mostra as diferenças.
- Visão de cobertura da empresa: `GET /data-lineage` (`cobertura.uncovered`).
