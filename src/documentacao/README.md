# Nayara One — API — Documentação

Índice da documentação técnica do backend (`NayaraOne--API`), gerado a partir da
fonte de verdade em `/Maturacao` (Marco 1 — Fundação Executável).

## Índice

- [ONBOARDING.md](./ONBOARDING.md) — como rodar o projeto localmente.
- [ENV_REFERENCE.md](./ENV_REFERENCE.md) — referência de todas as variáveis de ambiente.
- [models/](./models/) — um documento por schema físico do PostgreSQL, com todas as
  tabelas, colunas e relacionamentos modelados:
  - [Core.md](./models/Core.md)
  - [People.md](./models/People.md)
  - [RealEstate.md](./models/RealEstate.md)
  - [Crm.md](./models/Crm.md)
  - [Legal.md](./models/Legal.md)
  - [Finance.md](./models/Finance.md)
  - [Construction.md](./models/Construction.md)
  - [Inventory.md](./models/Inventory.md)
  - [Integration.md](./models/Integration.md)
  - [Ai.md](./models/Ai.md)
  - [Audit.md](./models/Audit.md)

## Escopo desta etapa

Esta etapa cobre exclusivamente a **camada de dados** (models Sequelize + migrations)
e o **esqueleto de aplicação** (Express, rotas, middlewares transversais, utilitários)
do Marco 1 (Fundação Executável), conforme `Maturacao/04_MAPA_DE_MARCOS_E_CRITERIOS_DE_ACEITE.md`.
Não inclui ainda: IAM/autenticação completa, Motor de Regras em execução, Motor de
Eventos (publisher/consumer do Outbox), regras de negócio dos domínios (Financeiro,
Contratos, Obras etc.) nem a camada NAY — esses itens pertencem aos Marcos 2 a 9.

## Convenções gerais do repositório

- 11 schemas físicos do PostgreSQL: `core, people, real_estate, crm, legal, finance,
  construction, inventory, integration, ai, audit` (não criar nenhum schema físico
  além destes — módulos de aplicação adicionais devem mapear tabelas para um destes
  11 schemas).
- Toda tabela usa `id` UUID (`DataTypes.UUIDV4`) como chave primária.
- Tabelas multiempresa possuem `group_id` e `company_id` (`NOT NULL`) e RLS
  `ENABLE` + `FORCE` com política deny-by-default (`tenant_isolation`).
- Dinheiro: `DECIMAL(18,2)`. Percentual: `DECIMAL(9,6)`. Datas: `timestamptz` (UTC).
- `lock_version` (controle de concorrência otimista) em entidades editáveis.
- Soft delete (`deleted_at`/`deleted_by`, `paranoid: true`) em tabelas
  cadastrais/operacionais; tabelas de ledger/auditoria/eventos são append-only
  (sem soft delete, apenas INSERT).
- Fluxo de aplicação: `routes → controller → service`. Controllers tratam apenas
  HTTP; regra de negócio vive em services; nenhuma chamada HTTP direta a sistema
  externo dentro de controller.
