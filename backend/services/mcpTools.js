/**
 * SAN & CO. — backend/services/mcpTools.js
 * Catálogo de ferramentas no formato padrão do MCP: cada uma tem `name`,
 * `description`, `inputSchema` em JSON Schema e um `handler`.
 *
 * O catálogo é independente de transporte de propósito. O mesmo array serve
 * o servidor MCP (para Hermes, Prometeu e Hefesto) e as rotas HTTP (para o
 * frontend), sem duplicar regra de negócio. Trocar de transporte não
 * reescreve ferramenta nenhuma.
 *
 * A DIVISÃO QUE IMPORTA
 *   Cinco ferramentas de leitura, marcadas readOnlyHint: true. Batem no
 *   Supabase, são baratas e um agente pode chamá-las à vontade.
 *
 *   Uma ferramenta de escrita, `financas_sincronizar`. Só ela fala com a
 *   Pluggy, e exige `confirmar: true` no argumento. Sem isso ela recusa e
 *   explica o motivo — um agente não dispara sincronização por engano ao
 *   tentar "atualizar os dados antes de responder".
 */

import {
  listarConexoes,
  obterSaldo,
  listarMovimentos,
  obterFaturas,
  sincronizarPluggy
} from './financasRepo.js';

/** Enum reaproveitado: os dois perfis existem em quase toda ferramenta. */
const PERFIL = {
  type: 'string',
  enum: ['PF', 'PJ'],
  description: 'PF para pessoa física, PJ para a empresa.'
};

export const ferramentas = [
  {
    name: 'financas_listar_conexoes',
    description:
      'Lista os bancos conectados via Open Finance, com o perfil (PF/PJ) de cada um '
      + 'e quantos dias faltam para o consentimento vencer. Use para responder sobre '
      + 'quais contas existem ou se alguma autorização está perto de expirar.',
    inputSchema: {
      type: 'object',
      properties: { perfil: PERFIL },
      required: [],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true },
    handler: (args) => listarConexoes(args)
  },

  {
    name: 'financas_saldo',
    description:
      'Saldo consolidado das contas correntes de um perfil, lido do banco local. '
      + 'Devolve saldo null quando nenhuma conta foi sincronizada ainda — null é '
      + '"não sei", diferente de zero, que é um saldo real.',
    inputSchema: {
      type: 'object',
      properties: { perfil: PERFIL },
      required: ['perfil'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true },
    handler: (args) => obterSaldo(args)
  },

  {
    name: 'financas_extrato',
    description:
      'Movimentos financeiros de um perfil, do mais recente para o mais antigo. '
      + 'Aceita filtro por tipo (entrada ou saída) e por data inicial.',
    inputSchema: {
      type: 'object',
      properties: {
        perfil: PERFIL,
        tipo: {
          type: 'string',
          enum: ['entrada', 'saida'],
          description: 'Omitir traz entradas e saídas juntas.'
        },
        desde: {
          type: 'string',
          format: 'date',
          description: 'Data inicial no formato AAAA-MM-DD.'
        },
        limite: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          default: 20,
          description: 'Quantidade máxima de movimentos.'
        }
      },
      required: ['perfil'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true },
    handler: (args) => listarMovimentos(args)
  },

  {
    name: 'financas_faturas',
    description:
      'Faturas de cartão de crédito abertas de um perfil, com limite total, '
      + 'limite disponível e a quebra por cartão.',
    inputSchema: {
      type: 'object',
      properties: { perfil: PERFIL },
      required: ['perfil'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true },
    handler: (args) => obterFaturas(args)
  },

  {
    name: 'financas_consentimentos',
    description:
      'Situação dos consentimentos de Open Finance: dias restantes de cada conexão '
      + 'sobre o prazo de 365 dias, e quais já venceram. Consentimento vencido faz a '
      + 'sincronização parar em silêncio, sem erro visível.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true },
    handler: async () => {
      const conexoes = await listarConexoes();
      return {
        prazo_total: 365,
        vencidos: conexoes.filter((c) => c.dias_restantes === 0).map((c) => c.instituicao),
        conexoes: conexoes.map(({ instituicao, perfil, dias_restantes }) => ({
          instituicao, perfil, dias_restantes
        }))
      };
    }
  },

  {
    name: 'financas_sincronizar',
    description:
      'ESCRITA. Busca dados novos na Pluggy e grava no banco local. É a ÚNICA '
      + 'ferramenta que consome cota da Pluggy. Não use para "atualizar antes de '
      + 'responder": as ferramentas de leitura já bastam. Chame apenas quando o '
      + 'usuário pedir a sincronização com todas as letras. Exige confirmar: true.',
    inputSchema: {
      type: 'object',
      properties: {
        confirmar: {
          type: 'boolean',
          description: 'Precisa ser true. Trava contra chamada acidental por um agente.'
        },
        conexaoId: {
          type: 'string',
          description: 'Sincronizar só esta conexão. Omitir sincroniza todas.'
        },
        forcar: {
          type: 'boolean',
          default: false,
          description: 'Ignora o intervalo mínimo entre sincronizações.'
        }
      },
      required: ['confirmar'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: async (args) => {
      if (args?.confirmar !== true) {
        return {
          executado: false,
          motivo:
            'Sincronização não confirmada. Ela gasta cota da Pluggy e só deve rodar a '
            + 'pedido explícito do usuário. Para os dados atuais, use as ferramentas de leitura.'
        };
      }
      const resultado = await sincronizarPluggy(args);
      return { executado: true, ...resultado };
    }
  }
];

/** Índice por nome, para o despacho não varrer o array a cada chamada. */
const porNome = new Map(ferramentas.map((f) => [f.name, f]));

/** Catálogo sem os handlers — é o que `tools/list` do MCP devolve. */
export function listarFerramentas() {
  return ferramentas.map(({ handler, ...publico }) => publico);
}

/**
 * Executa uma ferramenta pelo nome. Devolve sempre o envelope do MCP, com
 * `isError` em vez de lançar: um agente precisa ler a falha, não quebrar.
 *
 * @param {string} nome
 * @param {object} argumentos
 */
export async function executarFerramenta(nome, argumentos = {}) {
  const ferramenta = porNome.get(nome);

  if (!ferramenta) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Ferramenta desconhecida: ${nome}` }]
    };
  }

  try {
    const resultado = await ferramenta.handler(argumentos);
    return {
      content: [{ type: 'text', text: JSON.stringify(resultado, null, 2) }],
      structuredContent: resultado
    };
  } catch (erro) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Falha em ${nome}: ${erro.message}` }]
    };
  }
}
