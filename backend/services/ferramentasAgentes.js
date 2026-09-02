/**
 * SAN & CO. — backend/services/ferramentasAgentes.js
 * Ferramentas que um agente pode chamar de verdade durante uma conversa —
 * function calling da Gemini. Cada ferramenta tem duas metades: a
 * DECLARAÇÃO (o que a Gemini vê — nome, descrição, formato dos
 * parâmetros) e a EXECUÇÃO (a função JS que roda de verdade quando ela
 * decide chamar aquilo).
 *
 * REGRA DE FRONTEIRA — decidida com o usuário em 29/08/2026, não inventada:
 *   - Financeiro: SÓ LEITURA. Nenhum agente grava nada ali — nem
 *     categoria, nem valor, nada. Consultar_financeiro é a única
 *     ferramenta desse domínio, e ela não tem irmã de escrita.
 *   - Drive / Gmail / Agenda: leitura E escrita. A Miriel pode criar
 *     compromisso e mandar e-mail sempre que fizer sentido pro que foi
 *     pedido — SEM pedir confirmação antes. A supervisão não é bloquear
 *     a ação, é registrar ela (ver auditoriaAgentes.js) pra consulta
 *     posterior.
 *   - Só a Miriel tem esse poder de escrita hoje. Quando Lux e Nova
 *     existirem de verdade, elas só leem e podem CONTESTAR uma ação da
 *     Miriel — nunca escrevem nem revertem por conta própria. Esse
 *     mecanismo de contestação ainda não existe (não tem quem conteste
 *     ainda) — é o próximo andar em cima deste aqui, não este aqui.
 *   - Drive hoje só tem função de LEITURA construída (driveService.js) —
 *     escrever no Drive (mover/renomear/apagar arquivo) não existe ainda
 *     em lugar nenhum do backend, então não está no conjunto abaixo.
 *     Adicionar quando essas funções nascerem em driveService.js.
 *
 * FORMATO DAS DECLARAÇÕES — mesmo aviso de incerteza do geminiService.js:
 *   os tipos em maiúsculo (OBJECT/STRING/NUMBER) são o que eu sei do
 *   schema da Gemini pra function calling; não testado ao vivo.
 */

import { listarArquivosRecentes } from './driveService.js';
import { listarMensagensRecentes, enviarEmail } from './gmailService.js';
import { listarProximosEventos, criarEvento } from './calendarService.js';
import { obterResumoFinanceiro } from './financasRepo.js';
import { registrarAcaoAgente } from './auditoriaAgentes.js';

/**
 * `escreve: true` é o que decide se uma chamada bem-sucedida entra na
 * auditoria — não é opcional por ferramenta, é uma trava estrutural: se
 * um dia alguém adicionar uma ferramenta nova aqui e esquecer de marcar
 * `escreve: true` numa que muda dado de verdade, ela roda sem deixar
 * rastro. Cuidado ao adicionar ferramenta nova.
 */
const FERRAMENTAS = {
  consultar_financeiro: {
    escreve: false,
    declaracao: {
      name: 'consultar_financeiro',
      description:
        'Consulta o resumo financeiro do usuário: contas, saldo, entradas e saídas do mês, '
        + 'faturas de cartão. Somente leitura — nunca altera nada no Financeiro.',
      parameters: {
        type: 'OBJECT',
        properties: {
          perfil: { type: 'STRING', enum: ['PF', 'PJ'], description: 'Pessoa física ou jurídica' }
        },
        required: ['perfil']
      }
    },
    executar: async ({ perfil }) => obterResumoFinanceiro({ perfil })
  },

  listar_arquivos_drive: {
    escreve: false,
    declaracao: {
      name: 'listar_arquivos_drive',
      description: 'Lista os arquivos mais recentes do Google Drive do usuário.',
      parameters: {
        type: 'OBJECT',
        properties: { limite: { type: 'NUMBER', description: 'Quantos arquivos trazer, padrão 10' } }
      }
    },
    executar: async ({ limite }) => listarArquivosRecentes(limite ?? 10)
  },

  listar_emails: {
    escreve: false,
    declaracao: {
      name: 'listar_emails',
      description: 'Lista as mensagens mais recentes da caixa de entrada do Gmail (só metadados: assunto, remetente, resumo).',
      parameters: {
        type: 'OBJECT',
        properties: { limite: { type: 'NUMBER', description: 'Quantas mensagens trazer, padrão 10' } }
      }
    },
    executar: async ({ limite }) => listarMensagensRecentes(limite ?? 10)
  },

  enviar_email: {
    escreve: true,
    declaracao: {
      name: 'enviar_email',
      description:
        'Envia um e-mail em nome do usuário. Só use quando o pedido deixar claro que um '
        + 'e-mail deve ser enviado de verdade — nunca por conta própria sem isso ter sido pedido.',
      parameters: {
        type: 'OBJECT',
        properties: {
          para: { type: 'STRING', description: 'Endereço do destinatário' },
          assunto: { type: 'STRING' },
          corpo: { type: 'STRING', description: 'Texto simples do e-mail' }
        },
        required: ['para', 'assunto', 'corpo']
      }
    },
    executar: async (args) => enviarEmail(args)
  },

  listar_compromissos: {
    escreve: false,
    declaracao: {
      name: 'listar_compromissos',
      description: 'Lista os próximos compromissos da agenda do usuário a partir de agora.',
      parameters: {
        type: 'OBJECT',
        properties: { limite: { type: 'NUMBER', description: 'Quantos compromissos trazer, padrão 10' } }
      }
    },
    executar: async ({ limite }) => listarProximosEventos(limite ?? 10)
  },

  criar_compromisso: {
    escreve: true,
    declaracao: {
      name: 'criar_compromisso',
      description:
        'Cria um compromisso na agenda do usuário. Use quando o pedido deixar claro que algo '
        + 'deve ser marcado de verdade — não pra "sugerir" um horário, só pra marcar mesmo.',
      parameters: {
        type: 'OBJECT',
        properties: {
          titulo: { type: 'STRING' },
          inicio: { type: 'STRING', description: 'Data/hora ISO 8601 com fuso, ex.: 2026-08-30T09:00:00-03:00' },
          fim: { type: 'STRING', description: 'Data/hora ISO 8601 com fuso' },
          local: { type: 'STRING' },
          descricao: { type: 'STRING' }
        },
        required: ['titulo', 'inicio', 'fim']
      }
    },
    executar: async (args) => criarEvento(args)
  }
};

/** O array pronto pra passar em `tools: [{ functionDeclarations }]` na chamada à Gemini. */
export const declaracoesFerramentas = Object.values(FERRAMENTAS).map((f) => f.declaracao);

/**
 * Executa uma ferramenta pelo nome — é isto que vira `executarFerramenta`
 * na chamada de perguntarGemini(). Registra na auditoria automaticamente
 * quando a ferramenta é de escrita (ver o comentário sobre a trava
 * estrutural acima) — quem chama isto não precisa lembrar de auditar
 * nada na mão.
 *
 * @param {string} nome
 * @param {object} args
 * @param {{ agenteId?: string }} contexto
 */
export async function executarFerramenta(nome, args, contexto = {}) {
  const ferramenta = FERRAMENTAS[nome];
  if (!ferramenta) throw new Error(`Ferramenta desconhecida: "${nome}"`);

  const resultado = await ferramenta.executar(args ?? {});

  if (ferramenta.escreve) {
    await registrarAcaoAgente({
      agenteId: contexto.agenteId ?? 'hermes',
      ferramenta: nome,
      parametros: args ?? {},
      resultado
    }).catch((erro) => {
      // a auditoria falhar não pode fingir que a ação não aconteceu — o
      // e-mail já foi enviado, o evento já foi criado. Só loga o
      // problema de REGISTRO, não desfaz (nem poderia) a ação em si.
      console.error('[auditoria] falha ao registrar ação (a ação em si já foi executada de verdade):', erro.message);
    });
  }

  return resultado;
}
