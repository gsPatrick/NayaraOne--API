# Deploy da estrutura do Financeiro (M4-D140) — migrations em duas pastas

A demanda M4-D140 (Guia do Marco 4, §2) moveu o código do Financeiro para `src/modules/finance` e as 67 migrations que criam ou alteram objetos do schema `finance` para `src/modules/finance/infrastructure/db/migrations/`, com o MESMO nome de arquivo. Nenhuma migration nova foi criada e nenhuma foi alterada no conteúdo que roda no banco.

## O que muda no deploy: nada no comando

O comando de migração da homologação continua o mesmo:

```
npx sequelize-cli db:migrate --env migration
```

O `.sequelizerc` liga o executor único (`scripts/migrate.js`), que faz o `sequelize-cli` ler as duas pastas (`migrations/` e `src/modules/finance/infrastructure/db/migrations/`, lista em `src/config/migrationDirs.js`) e aplicar tudo na ordem global do nome do arquivo. Os atalhos do `package.json` fazem a mesma coisa:

| Atalho | Equivale a |
|---|---|
| `npm run migrate -- --env migration` | `npx sequelize-cli db:migrate --env migration` |
| `npm run migrate:status -- --env migration` | `npx sequelize-cli db:migrate:status --env migration` |
| `npm run migrate:undo -- --env migration` | `npx sequelize-cli db:migrate:undo --env migration` |
| `npm run migrate:undo:all -- --env migration --to <arquivo>` | `npx sequelize-cli db:migrate:undo:all --env migration --to <arquivo>` |

## Por que nada é reexecutado

A tabela `SequelizeMeta` guarda só o nome do arquivo. Como o nome não mudou, as 67 migrations movidas aparecem como já aplicadas. Num banco já migrado, depois do deploy:

- `npx sequelize-cli db:migrate:status --env migration` lista todas como `up` e nenhuma como `down`;
- `npx sequelize-cli db:migrate --env migration` responde "No migrations were executed, database schema was already up to date." (nenhuma linha nova na `SequelizeMeta`).

Prova feita em banco descartável (M4-D140, 11/11/2026): banco migrado no commit base `a8335d22` com 619 migrations; com o código novo, `status` deu 619 `up` e 0 `down`, `migrate` não aplicou nenhuma e a `SequelizeMeta` continuou com as mesmas 619 linhas. Banco vazio migrado no commit base e no commit novo (pelo executor e pelo comando direto): `pg_dump --schema-only` idêntico (as únicas linhas que variam são os instantes que as próprias migrations gravam em CHECK e índice parcial na hora em que rodam, iguais a duas execuções do commit base).

## Ordem do deploy

1. Backup do banco (como sempre).
2. Publicar a API do commit da demanda.
3. `npx sequelize-cli db:migrate:status --env migration` — esperado: nenhuma `down` (se houver, são migrations de outras demandas que entram neste deploy; nenhuma é desta).
4. `npx sequelize-cli db:migrate --env migration`.
5. `GET /health` e uma tela do Financeiro.

Reverter: reimplantar a API anterior. Não há migration desta demanda para desfazer.

## Migration nova do Financeiro, daqui em diante

`npx sequelize-cli migration:generate` continua criando o arquivo em `migrations/`. Se a migration cria ou altera objeto do schema `finance`, mova o arquivo para `src/modules/finance/infrastructure/db/migrations/` antes do commit: o teste `test/m4d140.estruturaFinanceiro.test.js` (`m4d140_migrations_financeiras_fora_da_raiz_e_nomes_intactos`) reprova migration financeira na pasta raiz (critério em `scripts/lib/financeMigrations.js`). Nome repetido nas duas pastas é erro do executor.
