# Referência de variáveis de ambiente

Todas as variáveis usadas pela aplicação e pelo `sequelize-cli`. Nenhum valor real
deve ser commitado — use `.env` local (fora do controle de versão) a partir de
`.env.example`.

| Variável | Obrigatória | Descrição |
|---|---|---|
| `NODE_ENV` | não (default `development`) | `development` \| `test` \| `staging` \| `production`. Controla verbosidade de erro e SSL de log. |
| `PORT` | não (default `3000`) | Porta HTTP do processo Express. |
| `APP_API_PREFIX` | não (default `/api`) | Prefixo sob o qual `src/routes/index.js` é montado em `app.js`. |
| `DATABASE_URL` | não* | Connection string completa do PostgreSQL (`postgres://user:pass@host:port/db`). Se definida, tem prioridade sobre as variáveis `DB_*` abaixo. |
| `DB_HOST` | sim, se `DATABASE_URL` ausente | Host do PostgreSQL. |
| `DB_PORT` | não (default `5432`) | Porta do PostgreSQL. |
| `DB_NAME` | sim, se `DATABASE_URL` ausente | Nome do banco. |
| `DB_USER` | sim, se `DATABASE_URL` ausente | Usuário de conexão (recomendado: role de privilégio mínimo, nunca superuser — ver `nayara_runtime`/`nayara_migration` em `02_BANCO_DE_DADOS_E_RLS.md` §3.4). |
| `DB_PASSWORD` | sim, se `DATABASE_URL` ausente | Senha de conexão. |
| `DB_SSL` | não (default `false`) | `true` para exigir SSL na conexão com o PostgreSQL (recomendado em produção). |
| `DB_POOL_MAX` | não (default `10`) | Tamanho máximo do pool de conexões Sequelize. |
| `DB_POOL_MIN` | não (default `0`) | Tamanho mínimo do pool. |
| `DB_POOL_ACQUIRE_MS` | não (default `30000`) | Timeout (ms) para obter conexão do pool. |
| `DB_POOL_IDLE_MS` | não (default `10000`) | Tempo (ms) até liberar conexão ociosa do pool. |
| `SMOKE_TEST_HOST` | não (default `localhost`) | Host usado pelo script `npm run smoke:test`. |
| `JWT_ACCESS_SECRET` | sim | Segredo HMAC usado para assinar/validar o access token (`src/utils/jwt.js`). Nunca reutilizar entre ambientes; nunca commitar valor real. |
| `JWT_REFRESH_SECRET` | sim | Segredo HMAC usado para assinar/validar o refresh token. Deve ser **diferente** de `JWT_ACCESS_SECRET`. |
| `JWT_ACCESS_TTL` | não (default `15m`) | Validade do access token (formato `jsonwebtoken`: `15m`, `1h`, etc.). |
| `JWT_REFRESH_TTL` | não (default `7d`) | Validade do refresh token — também usada para calcular `core.sessions.expires_at`. |
| `PII_HASH_SECRET` | sim | Segredo HMAC usado em `tax_id_normalized_hash` (busca exata de CPF/CNPJ sem expor o valor em claro, `src/features/people/personDocumentFormat.service.js`). Sem fallback — a aplicação lança `PII_HASH_CONFIG_MISSING` se ausente. Deve ser **diferente** dos segredos de JWT; nunca reutilizar entre ambientes; nunca commitar valor real. |

\* Ou `DATABASE_URL`, ou o conjunto `DB_HOST`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` — pelo
menos uma das duas formas é obrigatória para a aplicação conectar ao PostgreSQL.

## Roles de banco de dados: runtime x migration (implementado)

A aplicação (`app.js`, `npm run dev`/`npm start`) **nunca** deve conectar como o superuser do
SO/dono do banco — isso faz o Postgres dar BYPASS automático em RLS mesmo com
`FORCE ROW LEVEL SECURITY`, anulando todo o isolamento multi-tenant (`02_BANCO_DE_DADOS_E_RLS.md`
§3.4). Em desenvolvimento local, dois roles Postgres foram criados (ver comandos exatos abaixo)
e `.env` deve apontar `DB_USER`/`DB_PASSWORD` para o de runtime:

| Role | Uso | Atributos |
|---|---|---|
| `nayara_runtime` | `DB_USER` da aplicação (`app.js`) — o `.env` local usa este role. | `LOGIN`, **sem** `SUPERUSER`, **sem** `BYPASSRLS`. Apenas `USAGE` nos 11 schemas físicos + `SELECT/INSERT/UPDATE/DELETE` nas tabelas (via `ALTER DEFAULT PRIVILEGES`, cobre tabelas futuras de migrations). Nenhum privilégio de DDL. |
| `nayara_migration` | Usuário usado para rodar `npm run migrate`/`migrate:undo*` (`sequelize-cli`). | `LOGIN`, `CREATEDB`, dono dos 11 schemas físicos + `public` — pode rodar DDL. **Sem** `SUPERUSER`, **sem** `BYPASSRLS`. |

Comandos exatos usados para criar os roles em dev local (rodar como superuser do Postgres uma
única vez; senhas aqui são apenas de desenvolvimento — nunca reutilizar em produção):

```sql
CREATE ROLE nayara_runtime WITH LOGIN PASSWORD '<senha-dev>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
CREATE ROLE nayara_migration WITH LOGIN PASSWORD '<senha-dev>' NOSUPERUSER CREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
GRANT ALL PRIVILEGES ON DATABASE nayara_one_dev TO nayara_migration;

-- Por schema físico (core, people, real_estate, crm, legal, finance, construction, inventory,
-- integration, ai, audit) + public (SequelizeMeta):
GRANT USAGE ON SCHEMA <schema> TO nayara_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA <schema> TO nayara_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA <schema> TO nayara_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE nayara_migration IN SCHEMA <schema>
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nayara_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE nayara_migration IN SCHEMA <schema>
  GRANT USAGE, SELECT ON SEQUENCES TO nayara_runtime;
ALTER SCHEMA <schema> OWNER TO nayara_migration;
```

Para rodar migrations localmente com o role de DDL (sobrepõe `DB_USER`/`DB_PASSWORD` do `.env`
apenas para o comando, sem alterar o arquivo):

```bash
DB_USER=nayara_migration DB_PASSWORD=<senha-dev> npm run migrate
DB_USER=nayara_migration DB_PASSWORD=<senha-dev> npm run migrate:undo:all
```

**Em produção**: nenhum dos dois roles acima deve ter a senha hardcoded em `.env` — ambas devem
vir de um secrets manager (ex. AWS Secrets Manager / GCP Secret Manager / Vault), com rotação
periódica. `nayara_runtime` em produção deve ter exatamente os mesmos privilégios mínimos (sem
DDL, sem BYPASSRLS, sem SUPERUSER); migrations em produção devem rodar via pipeline de CI/CD
dedicado (nunca manualmente com credencial de runtime), usando um role equivalente a
`nayara_migration` com credencial de uso único/temporária, nunca o mesmo usuário que a aplicação
usa em runtime. Os roles adicionais mencionados em `02_BANCO_DE_DADOS_E_RLS.md` §3.4
(`nayara_worker`, `nayara_readonly`, `nayara_breakglass`) ainda não foram criados — ficam para um
próximo incremento quando os respectivos consumidores (jobs assíncronos, BI, acesso emergencial)
existirem.
