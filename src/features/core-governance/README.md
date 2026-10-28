# core-governance — Governança operacional (Marco 9, bloco E/F)

Feature em `src/features/core-governance` (decisão DI-ESTRUTURA-1: nunca existe `src/modules`; o que é feature fica em `src/features/<área>`), com a estrutura do livro (Guia do Marcelo §2). Oito subpastas, cada uma com `index.js` (exporta `router`, `service`, `events`), `*.routes.js`, `*.controller.js`, `*.service.js` e `README.md` com os 9 títulos fixos (M9-D891 confere o conteúdo).

| Subpasta | Prefixo de rota | Demandas |
|---|---|---|
| `calendar` | `/calendar` | M9-D801 a D803 |
| `data-quality` | `/data-quality` | M9-D804 a D808 |
| `lineage` | `/lineage` | M9-D810, D811 |
| `dlp` | `/dlp`, `/exports` | M9-D820 a D825 |
| `bcp` | `/bcp` | M9-D830 a D834 |
| `api-governance` | `/api-governance` | M9-D840 a D844 |
| `finops` | `/finops` | M9-D860 a D863 |
| `feature-flags` | `/feature-flags` | M9-D870 a D872 |

Arquivos comuns (na raiz, para a pasta continuar com exatamente 8 subpastas): `governance.errors.js` (corpo de erro único K5, prefixo `GOV_` K4), `governance.events.js` (catálogo fechado de 7 eventos), `governance.permissions.js` (21 permissões e concessão padrão), `governance.settings.js` (parâmetros do administrador), `governance.module.js` (fábrica de router com permissão e liga/desliga).

## Regras do alicerce
- Schema `governance`; toda tabela chama `governance.apply_tenant_rls('governance.<tabela>'::regclass)` na migration (RLS + FORCE RLS + política `tenant_isolation` + GRANT guardado por existência de `nayara_runtime`). Faixa de migrations do bloco E: `20260101000800` a `20260101000869`; do bloco F: `20260101000870` a `20260101000899`.
- Tudo que pode ser decidido pelo administrador é parâmetro (aba Governança em `/painel/configuracoes`): liga/desliga de cada módulo, lista de exceções ao prefixo `GOV_`, nomes dos perfis de Gestão e Financeiro para a concessão padrão.
- Ordem de construção: ver `Maturacao/demandas/marco-9/M9-D800-*.md` seção 3.5.
