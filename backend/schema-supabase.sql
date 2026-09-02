-- ============================================================================
-- SAN & CO. — Schema completo do Supabase
-- Gerado a partir das estruturas REAIS já usadas em memória no front-end
-- (js/dados.js, js/modules/panteao.js, js/modules/agenda.js) — cada tabela
-- bate campo a campo com o que o código já produz hoje, para a migração de
-- "em memória" para "persistido" não exigir mudar o formato do dado, só
-- onde ele mora.
--
-- COMO RODAR: cole este arquivo inteiro no SQL Editor do Supabase e execute
-- de uma vez — a ordem das tabelas já respeita as dependências (FK).
--
-- SOBRE RLS (Row Level Security): todas as tabelas têm RLS ativado, por
-- boa prática do Supabase — mas hoje o acesso é 100% via backend (Node),
-- usando a service_role key, que ignora RLS por padrão. As políticas
-- abaixo são um alicerce para quando existir login de usuário de verdade
-- (ver a conversa sobre isso no projeto — auth.js ainda é DEV_MODE); por
-- enquanto, elas não bloqueiam nada que o backend já faz.
-- ============================================================================


-- ============================================================================
-- BLOCO 1 — FINANCEIRO
-- ============================================================================

-- Uma linha por conta bancária/cartão — o "id" já é gerado pelo parser de
-- OFX no formato "<codigo>-<numero>" (ex.: "001-12345"), então o id aqui é
-- TEXT, não UUID, para não quebrar esse formato já em uso.
CREATE TABLE contas (
  id             TEXT PRIMARY KEY,
  perfil         TEXT NOT NULL CHECK (perfil IN ('PF', 'PJ')),
  nome           TEXT NOT NULL,
  codigo         TEXT,                      -- código do banco (BANKID do OFX), pode ser nulo em cartão
  numero         TEXT,                      -- ACCTID do OFX
  saldo          NUMERIC,
  origem         TEXT NOT NULL DEFAULT 'ofx',  -- 'ofx' | 'pluggy' (quando existir)
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Movimentos (extrato). O id vem do FITID do OFX (único por banco) ou de
-- um id manual — TEXT pelo mesmo motivo de contas.id.
CREATE TABLE movimentos (
  id          TEXT PRIMARY KEY,
  conta_id    TEXT REFERENCES contas(id) ON DELETE SET NULL,  -- pode ser nulo: nem todo movimento tem conta de origem identificada
  perfil      TEXT NOT NULL CHECK (perfil IN ('PF', 'PJ')),
  data        DATE NOT NULL,
  descricao   TEXT NOT NULL,
  valor       NUMERIC NOT NULL,
  tipo        TEXT NOT NULL CHECK (tipo IN ('entrada', 'saida')),
  status      TEXT NOT NULL DEFAULT 'liquidado',
  origem      TEXT NOT NULL DEFAULT 'ofx',
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_movimentos_perfil_data ON movimentos (perfil, data DESC);
CREATE INDEX idx_movimentos_conta ON movimentos (conta_id);

-- Ativos de investimento — instituicao vira coluna própria (usada pra cor
-- de marca no front, ver bancos.js) em vez de ficar dentro de um jsonb.
CREATE TABLE investimentos (
  id                  TEXT PRIMARY KEY,
  perfil              TEXT NOT NULL CHECK (perfil IN ('PF', 'PJ')),
  nome                TEXT NOT NULL,
  instituicao         TEXT NOT NULL,
  categoria           TEXT NOT NULL,   -- 'Renda Fixa' | 'Renda Variável' | 'Fundos/Previdência' | 'Cripto/Outros'
  valor_aplicado      NUMERIC,
  valor_atual         NUMERIC,
  data_vencimento     DATE,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Projetos (auto-provisionamento via checkout Asaas) — id pode ser o
-- project_id vindo do webhook, ou "manual-N" da criação manual: TEXT.
CREATE TABLE projetos (
  id                     TEXT PRIMARY KEY,
  perfil                 TEXT NOT NULL CHECK (perfil IN ('PF', 'PJ')),
  nome                   TEXT NOT NULL,
  escopo                 TEXT NOT NULL DEFAULT 'pessoal' CHECK (escopo IN ('pessoal', 'comercial')),
  cliente_id             TEXT,
  status                 TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo', 'construcao', 'desativado')),
  tipo_encerramento      TEXT CHECK (tipo_encerramento IN ('temporario', 'permanente')),
  categoria              TEXT NOT NULL DEFAULT 'Geral',
  chave_publica          TEXT,           -- prefixo da API key do checkout (origemCheckout.chavePublica)
  primeira_transacao     TIMESTAMPTZ,
  total_transacionado    NUMERIC NOT NULL DEFAULT 0,
  faturamento_mes        NUMERIC NOT NULL DEFAULT 0,
  despesas_mes           NUMERIC NOT NULL DEFAULT 0,
  lucro_liquido          NUMERIC NOT NULL DEFAULT 0,
  margem_lucro           NUMERIC,
  historico_6m           JSONB NOT NULL DEFAULT '[null,null,null,null,null,null]',
  diagnostico_ia         TEXT,           -- só a Lux escreve aqui — nunca vazio "fake" enquanto ela não existir
  ticket_medio           NUMERIC,
  cac                    NUMERIC,
  ltv                    NUMERIC,
  total_vendas           INTEGER NOT NULL DEFAULT 0,
  criado_em              TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_projetos_perfil_escopo ON projetos (perfil, escopo);


-- ============================================================================
-- BLOCO 2 — PANTEÃO (conversas com os agentes)
-- ============================================================================

CREATE TABLE panteao_conversas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo          TEXT NOT NULL DEFAULT 'Nova conversa',
  titulo_manual   BOOLEAN NOT NULL DEFAULT false,   -- true depois que o usuário renomeia à mão
  modo            TEXT NOT NULL DEFAULT 'multi' CHECK (modo IN ('multi', 'individual')),
  agente_id       TEXT CHECK (agente_id IN ('hermes', 'prometeu', 'hefesto')),  -- só preenchido em modo 'individual'
  excluida_em     TIMESTAMPTZ,        -- null = ativa; preenchida = foi pro "histórico excluído permanente"
  drive_file_id   TEXT,               -- id do arquivo no Drive, depois de arquivada
  criada_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizada_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_panteao_conversas_ativas ON panteao_conversas (criada_em DESC) WHERE excluida_em IS NULL;
CREATE INDEX idx_panteao_conversas_excluidas ON panteao_conversas (excluida_em DESC) WHERE excluida_em IS NOT NULL;

CREATE TABLE panteao_mensagens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversa_id  UUID NOT NULL REFERENCES panteao_conversas(id) ON DELETE CASCADE,
  autor        TEXT NOT NULL,          -- 'usuario' | 'hermes' | 'prometeu' | 'hefesto'
  agente_id    TEXT,                   -- nulo quando autor = 'usuario'
  texto        TEXT NOT NULL,
  acoes        JSONB NOT NULL DEFAULT '[]',
  timeline     JSONB,                  -- null = sem timeline (ex.: resposta real da Miriel); objeto = timeline simulada
  criada_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_panteao_mensagens_conversa ON panteao_mensagens (conversa_id, criada_em);


-- ============================================================================
-- BLOCO 3 — ROTINA
-- ============================================================================

-- Um registro por dia — "resetar à meia-noite" continua sendo só uma nova
-- linha com dia diferente, exatamente como já funciona em memória hoje.
CREATE TABLE rotina_protocolo (
  dia             DATE NOT NULL,
  perfil          TEXT NOT NULL CHECK (perfil IN ('PF', 'PJ')),
  tarefas_fixas   JSONB NOT NULL DEFAULT '{}',   -- { "Fluxo de caixa matinal": true, ... }
  treino          JSONB NOT NULL DEFAULT '{"divisao":"","concluido":false,"carga":""}',
  sono            JSONB NOT NULL DEFAULT '{"horas":null,"energia":null}',
  nutricao        JSONB NOT NULL DEFAULT '{"aguaL":0,"refeicoes":{},"suplementacao":""}',
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (dia, perfil)
);

CREATE TABLE rotina_notas (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  texto      TEXT NOT NULL,
  tags       JSONB NOT NULL DEFAULT '[]',
  forjada    BOOLEAN NOT NULL DEFAULT false,
  criada_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================================
-- BLOCO 4 — CHECKOUT (San Checkout)
-- Nota de arquitetura: estas duas tabelas fazem mais sentido num projeto
-- Supabase SEPARADO do San & Co. principal, pelo motivo de isolamento que
-- já discutimos (dado de terceiros pagando, base própria, raio de dano
-- menor numa eventual falha). Incluídas aqui porque foi pedido o schema
-- completo de uma vez — mas a decisão de onde elas realmente rodam ainda
-- está em aberto.
-- ============================================================================

CREATE TABLE checkout_contratantes (
  id              TEXT PRIMARY KEY,     -- o "contratante_id" opaco discutido (ex.: "321724506")
  nome            TEXT NOT NULL,
  logo_url        TEXT,
  tokens          JSONB NOT NULL DEFAULT '{}',   -- só --brand-primary/-hover/--brand-accent, ver themes.js
  asaas_customer_id TEXT,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE checkout_cobrancas (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contratante_id     TEXT NOT NULL REFERENCES checkout_contratantes(id),
  tipo               TEXT NOT NULL CHECK (tipo IN ('pix', 'cartao')),
  valor              NUMERIC NOT NULL,
  status             TEXT NOT NULL DEFAULT 'PENDING',   -- vocabulário do Asaas: PENDING/CONFIRMED/RECEIVED/OVERDUE/...
  asaas_charge_id    TEXT UNIQUE,
  pagador_nome       TEXT,
  pagador_email      TEXT,
  pagador_cpf        TEXT,
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_checkout_cobrancas_contratante ON checkout_cobrancas (contratante_id, criado_em DESC);


-- ============================================================================
-- ROW LEVEL SECURITY — ativado em todas, com política permissiva por
-- enquanto (ver nota no topo do arquivo: acesso hoje é só via backend,
-- que usa a service_role key e ignora RLS por padrão).
-- ============================================================================

DO $$
DECLARE
  tabela TEXT;
BEGIN
  FOR tabela IN
    SELECT unnest(ARRAY[
      'contas', 'movimentos', 'investimentos', 'projetos',
      'panteao_conversas', 'panteao_mensagens',
      'rotina_protocolo', 'rotina_notas',
      'checkout_contratantes', 'checkout_cobrancas'
    ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', tabela);
    EXECUTE format(
      'CREATE POLICY "acesso_via_service_role" ON %I FOR ALL USING (true) WITH CHECK (true);',
      tabela
    );
  END LOOP;
END $$;
