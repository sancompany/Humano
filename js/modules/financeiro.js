/**
 * SAN & CO. — módulo Finanças · Bloco 1 (casca executiva e reatividade)
 *
 * O QUE ESTE BLOCO ENTREGA
 *   - Barra de lentes [Entradas | Saídas] e botão compacto de troca PF/PJ.
 *   - Três cards executivos: fluxo ativo, cartões/Open Finance e projeção.
 *   - Extrato recente com badge de status.
 *   - Ação de topo [+ Lançar], sem comportamento ainda.
 *
 * REATIVIDADE
 *   Assina `perfil` e `lenteFinanceira` no state.js. A casca é montada uma
 *   única vez em render(); as trocas atualizam só as regiões dinâmicas, sem
 *   recriar a tela — assim o foco do teclado não se perde e não há piscada.
 *
 * DADOS
 *   Tudo aqui é mock, separado por PF/PJ. A única porta de entrada é
 *   js/dados.js, que é a única porta para Supabase, mock e .OFX.
 */

import { estado, observar, alternarPerfil, setLenteFinanceira, abrirDetalhe }
  from '../state.js';
import { carregarFinanceiro, moldeFinanceiro, importarOFX, registrarMovimentos, registrarConta,
         carregarInvestimentos, resumoPorCategoria, persistirImportacaoOfx }
  from '../dados.js';
import { corDoBanco, corDoBancoSuave } from '../bancos.js';
import patrimonio from './investimentos.js';
import conexoesModulo from './conexoes.js';
import projetosModulo from './projetos.js';
import detalhe from './detalhe.js';
import { derivarEvolucaoSaldo } from '../dados.js';
import { svgEvolucaoSaldo } from '../graficos.js';

/* ==================================================================
   1. DADOS
   O mock de PF/PJ, a normalização e o leitor de .OFX vivem em
   js/dados.js — este módulo só desenha. Assim a aba de
   Investimentos consome exatamente os mesmos dados, sem cópia.
   ================================================================== */

/** Enquanto true, a tela renderiza o molde vazio (atalho de teste). */
let simularVazio = false;

/** Último pacote recebido. A tela desenha a partir daqui. */
let dadosAtuais = moldeFinanceiro(estado.perfil);

/** Só usados pela sub-tela Overview — vazios até a 1ª sincronização dela. */
let evolucaoAtual = { pontos: [], absoluto: false, suficiente: false };
let investimentosAtuais = null;

/* ==================================================================
   2. FORMATAÇÃO
   ================================================================== */
const FORMATO_BRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2
});

const FORMATO_DATA = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' });

/**
 * Placeholder de valor ainda não carregado. O desenho imita a máscara de um
 * número em BRL para o layout não pular quando o dado real chegar — por isso
 * ele é renderizado em fonte monoespaçada.
 */
export const VALOR_VAZIO = 'R$ ---.---,--';

/**
 * Moeda brasileira. Ponto único de formatação de dinheiro no módulo.
 *
 * Devolve VALOR_VAZIO sempre que não houver número utilizável — saldo ainda
 * não sincronizado, conta sem consentimento válido, extrato vazio. Aqui
 * também é onde o Stealth Mode vai interceptar e devolver 'R$ ***.***,**'.
 *
 * @param {number|null|undefined} valor
 * @param {{ sinal?: boolean, positivo?: boolean }} opcoes
 * @returns {string}
 */
function brl(valor, { sinal = false, positivo = true } = {}) {
  if (!Number.isFinite(valor)) return VALOR_VAZIO;

  const texto = FORMATO_BRL.format(Math.abs(valor));
  if (!sinal) return texto;
  return `${positivo ? '+' : '−'}\u00A0${texto}`;   // U+2212, não hífen
}

/**
 * Versão HTML de brl(): quando o valor está ausente, envolve o placeholder
 * na classe que aplica a fonte monoespaçada.
 */
function brlHtml(valor, opcoes) {
  const texto = brl(valor, opcoes);
  return texto === VALOR_VAZIO
    ? `<span class="valor-vazio" aria-label="valor não carregado">${texto}</span>`
    : texto;
}

/** Percentual seguro: sem número, devolve travessão. */
function percentualOuVazio(valor) {
  return Number.isFinite(valor) ? percentual(valor) : '—';
}

/**
 * Variação percentual já com o sinal tipográfico correto.
 * @param {number} percentual
 */
function percentual(percentual) {
  const absoluto = Math.abs(percentual).toFixed(1).replace('.', ',');
  return `${percentual >= 0 ? '↑' : '↓'} ${absoluto}%`;
}

/**
 * '2026-08-14' -> '14 ago'. Monta a data como local para não escorregar
 * um dia por causa de fuso.
 * @param {string} iso
 */
function dataCurta(iso) {
  const [ano, mes, dia] = iso.split('-').map(Number);
  return FORMATO_DATA.format(new Date(ano, mes - 1, dia)).replace('.', '');
}

/** Escapa texto que vai para innerHTML — o mock é nosso, o Supabase não será. */
function escapar(texto) {
  return String(texto).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ==================================================================
   3. FRAGMENTOS DE INTERFACE
   ================================================================== */

/**
 * A variação é boa ou ruim? Subir entrada é bom; subir saída é ruim.
 * Sem isso, um aumento de 12% nos gastos apareceria em verde.
 */
function variacaoPositiva(valor, lente) {
  if (lente === 'saidas') return valor <= 0;
  return valor >= 0;   // entradas e resultado líquido: subir é bom
}

/**
 * Reduz as três lentes a um único formato para o card de fluxo.
 * `estado` vira a cor da faixa indicadora sob o número.
 *
 * @param {object} dados
 * @param {'todos'|'entradas'|'saidas'} lente
 */
function fluxoDaLente(dados, lente) {
  const { entradas, saidas } = dados.fluxo;

  if (lente === 'entradas') {
    return { titulo: 'Entradas do mês', ...entradas, estado: 'positivo' };
  }
  if (lente === 'saidas') {
    return { titulo: 'Saídas do mês', ...saidas, estado: 'negativo' };
  }

  // 'todos': resultado líquido do mês. Só existe com os dois lados carregados.
  const temAmbos = Number.isFinite(entradas.total) && Number.isFinite(saidas.total);
  const total = temAmbos ? entradas.total - saidas.total : null;

  const temAnterior = Number.isFinite(entradas.anterior) && Number.isFinite(saidas.anterior);
  const anterior = temAnterior ? entradas.anterior - saidas.anterior : null;

  const variacao = temAmbos && temAnterior && anterior !== 0
    ? ((total - anterior) / Math.abs(anterior)) * 100
    : null;

  return {
    titulo: 'Resultado do mês',
    total,
    variacao,
    anterior,
    subtitulo: 'Entradas menos saídas no período',
    estado: total === null ? 'neutro' : total >= 0 ? 'positivo' : 'negativo'
  };
}

const SVG_TROCA = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="16 4 20 8 16 12"/><line x1="20" y1="8" x2="5" y2="8"/>
    <polyline points="8 12 4 16 8 20"/><line x1="4" y1="16" x2="19" y2="16"/>
  </svg>`;

/** Botão compacto de troca PF/PJ — vive no cabeçalho, vale nas duas sub-telas. */
function htmlTrocaPerfil(perfil) {
  return `
    <button class="troca-perfil" type="button" data-acao="trocar-perfil"
            aria-label="Perfil ativo: ${perfil}. Alternar para ${perfil === 'PF' ? 'PJ' : 'PF'}">
      ${SVG_TROCA}
      <span class="troca-perfil__badge">${perfil}</span>
    </button>
  `;
}

/** Gráfico compartilhado com detalhe.js — ver js/graficos.js. */

/** Barra de filtros do extrato — só existe na sub-tela de fluxo. */
function htmlControles(lente) {
  return `
    <div class="lentes" role="group" aria-label="Filtro de transações">
      <button class="lentes__btn" type="button" data-lente="todos"
              aria-pressed="${lente === 'todos'}">Todos</button>
      <button class="lentes__btn" type="button" data-lente="entradas"
              aria-pressed="${lente === 'entradas'}">Entradas</button>
      <button class="lentes__btn" type="button" data-lente="saidas"
              aria-pressed="${lente === 'saidas'}">Saídas</button>
    </div>
  `;
}

/**
 * Card de contas bancárias da Overview — diferente da fita horizontal que
 * já existe em Fluxo: aqui é vertical, com o saldo somado no topo e uma
 * linha por instituição embaixo, no formato do card do Pluggy.
 */
function htmlCardContas(dados) {
  const contas = dados.contas ?? [];
  const total = contas.length
    ? contas.reduce((s, c) => s + (Number.isFinite(c.saldo) ? c.saldo : 0), 0)
    : null;

  const linhas = contas.length
    ? contas.map((c) => `
        <li class="conta-linha" data-clickable="true" role="button" tabindex="0"
            data-detalhe="contas" data-id="${escapar(c.id ?? c.nome)}"
            style="--marca: ${corDoBanco(c.nome)}">
          <span class="conta-linha__nome">${escapar(c.nome)}</span>
          <span class="conta-linha__saldo">${brlHtml(c.saldo)}</span>
        </li>
      `).join('')
    : `<li class="conta-linha conta-linha--vazia"><span>Nenhuma conta conectada</span></li>`;

  return `
    <article class="card-exec" data-clickable="true" role="button" tabindex="0"
             data-detalhe="contas" data-id="todas"
             aria-label="Contas bancárias: ${brl(total)}. Abrir detalhamento.">
      <header class="card-exec__topo">
        <span class="card-exec__label">Contas bancárias</span>
      </header>
      <p class="card-exec__valor">${brlHtml(total)}</p>
      <span class="card-exec__faixa card-exec__faixa--neutro" aria-hidden="true"></span>
      <ul class="conta-lista">${linhas}</ul>
    </article>
  `;
}

/**
 * Card de investimentos da Overview — versão resumida do que a aba Ativos
 * mostra em detalhe. `investimentos` vem de carregarInvestimentos(), uma
 * busca própria que só a Overview dispara.
 */
function htmlCardInvestimentos(investimentos) {
  const alocacaoComValor = (investimentos?.alocacao ?? []).filter((a) => a.quantidade > 0);

  return `
    <article class="card-exec" data-clickable="true" role="button" tabindex="0"
             data-detalhe="patrimonio" data-id="investido"
             aria-label="Investimentos: ${brl(investimentos?.totalInvestido)}. Abrir detalhamento.">
      <header class="card-exec__topo">
        <span class="card-exec__label">Investimentos</span>
      </header>
      <p class="card-exec__valor">${brlHtml(investimentos?.totalInvestido)}</p>
      <span class="card-exec__faixa card-exec__faixa--neutro" aria-hidden="true"></span>
      <p class="card-exec__sub">
        ${investimentos?.ativos?.length ?? 0} ${investimentos?.ativos?.length === 1 ? 'ativo' : 'ativos'} em carteira
      </p>

      ${alocacaoComValor.length ? `
        <div class="barra-consumo" role="img" aria-label="Proporção por classe de ativo">
          <div class="barra-consumo__usado" style="width: 100%">
            ${alocacaoComValor.map((a) => `
              <span class="barra-consumo__parte"
                    style="flex: ${a.valor ?? 0}; background: ${
                      { 'Renda Fixa': 'var(--info)', 'Renda Variável': 'var(--indigo)',
                        'Fundos/Previdência': 'var(--success)', 'Cripto/Outros': 'var(--violeta)' }[a.categoria]
                    }" title="${a.categoria}"></span>
            `).join('')}
          </div>
        </div>
      ` : ''}
    </article>
  `;
}

/**
 * Um bloco de ranking de categoria — "Despesas" (liquidadas) ou
 * "Despesas futuras" (pendentes). Mesma leitura da Pluggy: nome da
 * categoria, barra proporcional ao maior valor do bloco, valor à direita.
 * Cada linha abre o mesmo contexto dedicado ('categorias'), onde dá para
 * filtrar o extrato por aquela categoria específica.
 *
 * @param {'liquidado'|'pendente'} status
 * @param {string} titulo
 * @param {string} subtitulo
 * @param {Array<{categoria:string, valor:number}>} lista
 */
function htmlBlocoCategoria(status, titulo, subtitulo, lista) {
  const total = lista.reduce((s, item) => s + item.valor, 0);
  const maior = lista[0]?.valor ?? 0;

  const linhas = lista.length
    ? lista.map((item) => `
        <li class="categoria-linha">
          <div class="categoria-linha__topo">
            <span class="categoria-linha__nome">${escapar(item.categoria)}</span>
            <span class="categoria-linha__valor">${brlHtml(item.valor)}</span>
          </div>
          <div class="categoria-linha__trilho">
            <span class="categoria-linha__barra"
                  style="width: ${maior > 0 ? ((item.valor / maior) * 100).toFixed(1) : 0}%"></span>
          </div>
        </li>
      `).join('')
    : `<li class="categoria-linha categoria-linha--vazia">
         Nenhuma ${status === 'pendente' ? 'despesa pendente' : 'transação categorizada'} no período.
       </li>`;

  return `
    <article class="card-exec" data-clickable="true" role="button" tabindex="0"
             data-detalhe="categorias" data-id="${status}"
             aria-label="${titulo}: ${brl(total)}. Abrir detalhamento por categoria.">
      <header class="card-exec__topo">
        <span class="card-exec__label">${titulo}</span>
        <span class="card-exec__tag">${status === 'pendente' ? 'Pendente' : 'Categorizado'}</span>
      </header>
      <p class="card-exec__valor">${brlHtml(total)}</p>
      <span class="card-exec__faixa card-exec__faixa--${status === 'pendente' ? 'atencao' : 'negativo'}" aria-hidden="true"></span>
      <p class="card-exec__sub">${subtitulo}</p>
      <ul class="categoria-lista">${linhas}</ul>
    </article>
  `;
}

/** Os dois blocos de categoria — despesas liquidadas e despesas futuras. */
function htmlCategorias(dados) {
  const resumo = resumoPorCategoria(dados.extrato ?? []);
  return `
    <div class="categoria-blocos">
      ${htmlBlocoCategoria('liquidado', 'Despesas', 'Transações categorizadas', resumo.liquidado)}
      ${htmlBlocoCategoria('pendente', 'Despesas futuras', 'Transações pendentes', resumo.pendente)}
    </div>
  `;
}

/** Conteúdo da sub-tela Overview: os três cards + o gráfico de evolução. */
function htmlOverview(dados, evolucao, investimentos) {
  const bloco = document.createElement('div');
  bloco.dataset.subtela = 'overview';
  bloco.innerHTML = `
    <div class="fin-cards fin-cards--tres">
      ${htmlCardContas(dados)}
      ${htmlCardCartoes(dados)}
      ${htmlCardInvestimentos(investimentos)}
    </div>

    <section class="section">
      <p class="section__label" data-regiao="evolucao-label">Evolução do saldo</p>
      <div class="card-exec card-exec--grafico" data-clickable="true" role="button" tabindex="0"
           data-detalhe="evolucao" data-id="12m">
        <p class="card-exec__valor" data-regiao="evolucao-total">
          ${evolucao.suficiente ? brlHtml(evolucao.pontos.at(-1).saldo) : brlHtml(null)}
        </p>
        <p class="card-exec__sub">
          ${evolucao.suficiente
            ? (evolucao.absoluto ? `Saldo atual, ${evolucao.pontos.length} meses` : `Variação relativa, ${evolucao.pontos.length} meses — sem saldo de conta para ancorar o valor absoluto`)
            : 'Aguardando ao menos 2 meses de movimentação'}
        </p>
        ${svgEvolucaoSaldo(evolucao)}
      </div>
    </section>
  `;
  return bloco;
}

/** Conteúdo da sub-tela de fluxo: filtros, cards e extrato. */
function htmlFluxo() {
  const bloco = document.createElement('div');
  bloco.dataset.subtela = 'fluxo';
  bloco.innerHTML = `
    <div class="fin-controles">
      ${htmlControles(estado.lenteFinanceira)}
    </div>

    <div data-regiao="contas"></div>

    <div class="fin-cards" data-regiao="cards"></div>

    <section class="section">
      <p class="section__label">Despesas por categoria</p>
      <div data-regiao="categorias"></div>
    </section>

    <section class="section">
      <p class="section__label" data-regiao="extrato-titulo">Movimentos recentes</p>

      <!-- entrada de dados enquanto a Pluggy não sincroniza -->
      <label class="dropzone" data-dropzone>
        <input class="dropzone__input" type="file" accept=".ofx,.OFX" hidden data-arquivo-ofx>
        <span class="dropzone__icone" aria-hidden="true"></span>
        <span class="dropzone__texto">
          <strong>Importar extrato .OFX</strong>
          <span class="dropzone__dica">Arraste o arquivo aqui ou toque para escolher</span>
        </span>
      </label>
      <p class="dropzone__retorno" data-regiao="ofx-retorno" role="status" hidden></p>

      <div data-regiao="extrato"></div>
    </section>
  `;
  return bloco;
}

/**
 * Linha horizontal com as contas conectadas e o saldo de cada uma.
 * Sem conta nenhuma, mostra um cartão neutro com o placeholder — nada de
 * inventar nome de banco só para preencher a barra.
 */
function htmlContas(dados) {
  const contas = dados.contas ?? [];

  if (!contas.length) {
    return `
      <div class="contas">
        <div class="conta conta--vazia">
          <span class="conta__nome">Nenhuma conta conectada</span>
          <span class="conta__saldo">${brlHtml(null)}</span>
        </div>
      </div>
    `;
  }

  return `
    <div class="contas" role="list" aria-label="Contas conectadas">
      ${contas.map((conta) => `
        <div class="conta" role="listitem" style="--marca: ${corDoBanco(conta.nome)}">
          <span class="conta__nome">${escapar(conta.nome)}</span>
          <span class="conta__saldo">${brlHtml(conta.saldo)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function htmlCardFluxo(dados, lente) {
  const fluxo = fluxoDaLente(dados, lente);
  const bom = variacaoPositiva(fluxo.variacao, lente);

  return `
    <article class="card-exec card-exec--destaque" data-clickable="true"
             role="button" tabindex="0" data-detalhe="fluxo" data-id="${lente}"
             aria-label="${fluxo.titulo}: ${brl(fluxo.total)}. Abrir detalhamento.">
      <header class="card-exec__topo">
        <span class="card-exec__label">${fluxo.titulo}</span>
        <span class="variacao ${bom ? 'variacao--boa' : 'variacao--ruim'}">
          ${percentualOuVazio(fluxo.variacao)}
        </span>
      </header>

      <p class="card-exec__valor">${brlHtml(fluxo.total)}</p>
      <span class="card-exec__faixa card-exec__faixa--${fluxo.estado}" aria-hidden="true"></span>
      <p class="card-exec__sub">${escapar(fluxo.subtitulo)}</p>

      <footer class="card-exec__rodape">
        <span>Mês anterior</span>
        <span class="card-exec__ref">${brlHtml(fluxo.anterior)}</span>
      </footer>
    </article>
  `;
}

/** Acima deste consumo do limite, a barra vira vermelha (gasto no teto). */
const LIMIAR_ALERTA = 80;

function htmlCardCartoes(dados) {
  const { faturasAbertas, limiteTotal, limiteDisponivel, detalhes = [] } = dados.cartoes;

  // sem os dois números não há proporção: a barra some em vez de mentir
  const temProporcao = Number.isFinite(faturasAbertas) && Number.isFinite(limiteTotal) && limiteTotal > 0;
  const usoPercentual = temProporcao ? (faturasAbertas / limiteTotal) * 100 : 0;
  const noTeto = temProporcao && usoPercentual >= LIMIAR_ALERTA;

  // cada emissor entra com a cor da própria marca — ver js/bancos.js
  const segmentos = detalhes.map((cartao) => `
    <span class="barra-consumo__parte"
          style="flex: ${cartao.valor ?? 0}; background: ${corDoBanco(cartao.nome)}"
          title="${escapar(cartao.nome)}: ${brl(cartao.valor)}"></span>
  `).join('');

  const legenda = detalhes.map((cartao) => `
    <li class="legenda__item">
      <span class="legenda__ponto" aria-hidden="true"
            style="background: ${corDoBanco(cartao.nome)}"></span>
      <span class="legenda__nome"
            style="color: ${corDoBanco(cartao.nome)}">${escapar(cartao.nome)}</span>
      <span class="legenda__valor">${brlHtml(cartao.valor)}</span>
    </li>
  `).join('');

  return `
    <article class="card-exec" data-clickable="true"
             role="button" tabindex="0" data-detalhe="cartoes" data-id="faturas"
             aria-label="Faturas abertas: ${brl(faturasAbertas)}. Abrir detalhamento.">
      <header class="card-exec__topo">
        <span class="card-exec__label">Faturas abertas</span>
        <span class="card-exec__tag">Open Finance</span>
      </header>

      <p class="card-exec__valor">${brlHtml(faturasAbertas)}</p>
      <span class="card-exec__faixa card-exec__faixa--${noTeto ? 'negativo' : 'atencao'}" aria-hidden="true"></span>

      <div class="barra-consumo ${noTeto ? 'barra-consumo--alerta' : ''}" role="img"
           aria-label="${temProporcao ? `Consumo de ${usoPercentual.toFixed(0)}% do limite total` : 'Consumo do limite não carregado'}">
        <div class="barra-consumo__usado" style="width: ${temProporcao ? usoPercentual.toFixed(1) : 0}%">
          ${segmentos}
        </div>
      </div>

      <p class="card-exec__uso ${noTeto ? 'card-exec__uso--alerta' : ''}">
        ${temProporcao
          ? `${usoPercentual.toFixed(0)}% do limite comprometido`
          : '<span class="valor-vazio">--%</span> do limite comprometido'}
      </p>

      ${!temProporcao ? `
        <p class="card-exec__aviso">
          Limite por cartão só chega pela Pluggy — o arquivo .OFX não carrega
          esse dado. Fica disponível assim que a sincronização estiver ativa.
        </p>
      ` : ''}

      <ul class="legenda">${legenda}</ul>

      <footer class="card-exec__rodape">
        <span>Limite disponível</span>
        <span class="card-exec__ref card-exec__ref--estimado">${brlHtml(limiteDisponivel)}</span>
      </footer>
    </article>
  `;
}

function htmlCardProjecao(dados) {
  const { d7, d30 } = dados.projecao;
  const temDelta = Number.isFinite(d7) && Number.isFinite(d30);
  const delta = temDelta ? d30 - d7 : null;

  return `
    <article class="card-exec" data-clickable="true"
             role="button" tabindex="0" data-detalhe="projecao" data-id="30d"
             aria-label="Projeção líquida em 30 dias: ${brl(d30)}. Abrir detalhamento.">
      <header class="card-exec__topo">
        <span class="card-exec__label">Projeção líquida</span>
        <span class="card-exec__tag">30 dias</span>
      </header>

      <p class="card-exec__valor">${brlHtml(d30)}</p>
      <span class="card-exec__faixa card-exec__faixa--neutro" aria-hidden="true"></span>

      <div class="projecao">
        <div class="projecao__linha">
          <span class="projecao__prazo">Em 7 dias</span>
          <span class="projecao__valor">${brlHtml(d7)}</span>
        </div>
        <div class="projecao__linha">
          <span class="projecao__prazo">Diferença no período</span>
          <span class="projecao__valor ${!temDelta ? '' : delta >= 0 ? 'projecao__valor--sobe' : 'projecao__valor--desce'}">
            ${brlHtml(delta, { sinal: true, positivo: temDelta && delta >= 0 })}
          </span>
        </div>
      </div>
    </article>
  `;
}

/** Tipo de movimento que cada lente enxerga. 'todos' não filtra nada. */
const TIPO_DA_LENTE = { entradas: 'entrada', saidas: 'saida' };

/**
 * Extrato filtrado pela lente ativa: a lente de Entradas mostra só entradas.
 * @param {object} dados
 * @param {'entradas'|'saidas'} lente
 */
function htmlExtrato(dados, lente) {
  const tipo = TIPO_DA_LENTE[lente];
  const movimentos = (tipo ? dados.extrato.filter((mov) => mov.tipo === tipo) : dados.extrato)
    .slice(0, 5);

  if (!movimentos.length) {
    const oQue = { entradas: 'entrada', saidas: 'saída', todos: 'transação' }[lente];
    return `<p class="extrato__vazio">Nenhuma ${oQue} registrada no período.</p>`;
  }

  const itens = movimentos.map((mov) => {
    const entrada = mov.tipo === 'entrada';
    return `
      <li class="extrato__item" data-clickable="true"
          role="button" tabindex="0" data-detalhe="transacao" data-id="${mov.id}"
          aria-label="${escapar(mov.descricao)}, ${brl(mov.valor)}, ${mov.status}. Abrir detalhamento.">
        <span class="extrato__data">${dataCurta(mov.data)}</span>

        <span class="extrato__corpo">
          <span class="extrato__desc">${escapar(mov.descricao)}</span>
          <span class="badge-status badge-status--${mov.status}">
            ${mov.status === 'liquidado' ? 'Liquidado' : 'Pendente'}
          </span>
        </span>

        <span class="extrato__valor ${entrada ? 'extrato__valor--entrada' : 'extrato__valor--saida'}">
          ${brlHtml(mov.valor, { sinal: true, positivo: entrada })}
        </span>
      </li>
    `;
  }).join('');

  return `<ul class="extrato">${itens}</ul>`;
}

/* ==================================================================
   4. MÓDULO
   ================================================================== */
let raiz = null;              // elemento da view montada
let cancelarObservadores = [];
let aoClicar = null;
let aoTeclar = null;
let aoEscolherArquivo = null;
let aoArrastar = null;

/** Evita que uma busca lenta sobrescreva outra mais recente. */
let fichaAtual = 0;

/**
 * Busca os dados do perfil e redesenha as regiões dinâmicas.
 * A casca permanece no DOM — só o conteúdo é reescrito.
 */
async function sincronizar({ animar = true } = {}) {
  if (!raiz) return;

  const perfil = estado.perfil;
  const lente = estado.lenteFinanceira;

  // o cabeçalho é comum às duas sub-telas e sempre acompanha o perfil
  raiz.querySelector('[data-regiao="contexto"]').textContent =
    perfil === 'PJ' ? 'Pessoa jurídica' : 'Pessoa física';

  const troca = raiz.querySelector('.troca-perfil');
  troca.querySelector('.troca-perfil__badge').textContent = perfil;
  troca.setAttribute(
    'aria-label',
    `Perfil ativo: ${perfil}. Alternar para ${perfil === 'PF' ? 'PJ' : 'PF'}`
  );

  // Overview e Fluxo são as duas leituras do mesmo `dados`; Ativos e
  // Conexões desenham sozinhos (vizinhos, com seu próprio sincronizar()).
  if (raiz.dataset.sub !== 'fluxo' && raiz.dataset.sub !== 'overview') return;

  const ficha = ++fichaAtual;
  const dados = simularVazio ? moldeFinanceiro(perfil) : await carregarFinanceiro(perfil);

  // outra troca de perfil aconteceu enquanto esta busca estava no ar
  if (ficha !== fichaAtual || !raiz) return;
  dadosAtuais = dados;
  anunciarFrescura(dados);

  if (raiz.dataset.sub === 'overview') {
    evolucaoAtual = derivarEvolucaoSaldo(dados.extrato, dados.contas);
    investimentosAtuais = simularVazio ? null : await carregarInvestimentos(perfil);
    if (ficha !== fichaAtual || !raiz) return;

    const atual = raiz.querySelector('[data-subtela="overview"]');
    if (atual) atual.replaceWith(htmlOverview(dadosAtuais, evolucaoAtual, investimentosAtuais));
    return;
  }

  // controles
  raiz.querySelectorAll('.lentes__btn').forEach((botao) => {
    botao.setAttribute('aria-pressed', String(botao.dataset.lente === lente));
  });

  // contas conectadas, cards e extrato
  const areaContas = raiz.querySelector('[data-regiao="contas"]');
  if (areaContas) areaContas.innerHTML = htmlContas(dados);

  const cards = raiz.querySelector('[data-regiao="cards"]');
  cards.innerHTML = htmlCardFluxo(dados, lente)
                  + htmlCardCartoes(dados)
                  + htmlCardProjecao(dados);

  const areaCategorias = raiz.querySelector('[data-regiao="categorias"]');
  if (areaCategorias) areaCategorias.innerHTML = htmlCategorias(dados);

  raiz.querySelector('[data-regiao="extrato-titulo"]').textContent =
    { todos: 'Movimentos recentes', entradas: 'Entradas recentes', saidas: 'Saídas recentes' }[lente];
  raiz.querySelector('[data-regiao="extrato"]').innerHTML = htmlExtrato(dados, lente);

  // pulso curto para o olho perceber que o número trocou
  if (animar) {
    raiz.querySelectorAll('.card-exec__valor').forEach((valor) => {
      valor.classList.remove('valor--pulso');
      void valor.offsetWidth;              // força reflow para reiniciar a animação
      valor.classList.add('valor--pulso');
    });
  }
}

/* ------------------------------------------------------------------
   LEMBRETE SEMANAL DE .OFX
   O consentimento da Pluggy expira e a sincronização automática para em
   silêncio. Enquanto isso não é resolvido, o extrato entra por arquivo
   .OFX toda semana — e o header é quem lembra.
------------------------------------------------------------------ */

const DIAS_ENTRE_ENVIOS = 7;
const DOMINGO = 0;

/** Meia-noite local da data, para comparar dias sem tropeçar no fuso. */
function inicioDoDia(valor) {
  const d = valor instanceof Date ? new Date(valor) : new Date(`${valor}T00:00:00`);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * O lembrete de envio está devido?
 * @returns {{ devido: boolean, dias: number|null, atrasado: boolean }}
 */
function lembreteOfx(ultimoEnvio) {
  const hoje = inicioDoDia(new Date());
  const ehDomingo = hoje.getDay() === DOMINGO;

  if (!ultimoEnvio) return { devido: true, dias: null, atrasado: true };

  const enviado = inicioDoDia(ultimoEnvio);
  const dias = Math.floor((hoje - enviado) / 86_400_000);

  // passou da semana: cobra em qualquer dia, não só no domingo
  if (dias >= DIAS_ENTRE_ENVIOS + 1) return { devido: true, dias, atrasado: true };

  // é domingo e ainda não veio arquivo hoje: cobra sem alarme
  if (ehDomingo && dias > 0) return { devido: true, dias, atrasado: false };

  return { devido: false, dias, atrasado: false };
}

/**
 * Traduz o carimbo da última sincronização no indicador do header.
 *
 * É o que faz aquele espaço valer alguma coisa: num painel financeiro a
 * pergunta que importa é "esses números são de agora?". O modo de falha do
 * Open Finance é silencioso — o consentimento vence e a sincronização
 * simplesmente para, sem erro na tela.
 */
function anunciarFrescura(dados) {
  // o pedido de arquivo vem antes da frescura: é o que exige ação do usuário
  const lembrete = lembreteOfx(dados.ultimoEnvioOfx);
  if (lembrete.devido) {
    if (lembrete.dias === null) return anunciar('Enviar OFX da semana', 'alerta');
    if (lembrete.atrasado) return anunciar(`OFX atrasado · ${lembrete.dias} dias`, 'alerta');
    return anunciar('Domingo de OFX · enviar', 'pending');
  }

  const carimbo = dados.sincronizadoEm ? new Date(dados.sincronizadoEm) : null;

  if (!carimbo || Number.isNaN(carimbo.getTime())) {
    return anunciar('Sem sincronização', 'alerta');
  }

  const horas = (Date.now() - carimbo.getTime()) / 3_600_000;

  if (horas < 6) {
    const hora = carimbo.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return anunciar(`Sincronizado ${hora}`, 'secure');
  }
  if (horas < 48) {
    return anunciar(`Desatualizado · ${Math.floor(horas)}h`, 'pending');
  }

  const dias = Math.floor(horas / 24);
  return anunciar(`Desatualizado · ${dias} dias`, 'alerta');
}

/** Atalho para o evento de status do header. */
function anunciar(label, tone) {
  document.dispatchEvent(new CustomEvent('sanco:status', { detail: { label, tone } }));
}

/**
 * Lê o .OFX escolhido, guarda os movimentos e redesenha a tela.
 *
 * A deduplicação é do dados.js, pelo FITID: reimportar o mesmo extrato não
 * duplica lançamento. Os movimentos vivem em memória até o backend existir —
 * some ao recarregar a página, e o retorno abaixo diz isso.
 */
async function tratarArquivoOfx(arquivo) {
  const retorno = raiz?.querySelector('[data-regiao="ofx-retorno"]');
  const mostrar = (texto, tom) => {
    if (!retorno) return;
    retorno.textContent = texto;
    retorno.dataset.tom = tom;
    retorno.hidden = false;
  };

  if (!arquivo) return;
  if (!/\.ofx$/i.test(arquivo.name)) {
    return mostrar('Formato não reconhecido. O arquivo precisa ser .OFX.', 'erro');
  }

  mostrar(`Lendo ${arquivo.name}…`, 'neutro');

  try {
    const { conta, movimentos } = await importarOFX(arquivo);
    registrarConta(conta, estado.perfil);

    // cada movimento carrega de qual conta veio — sem isso, a tela de
    // detalhe de Contas não teria como filtrar o extrato por instituição
    if (conta?.id) movimentos.forEach((m) => { m.contaId = conta.id; });

    const { novos, repetidos, total } = registrarMovimentos(movimentos, estado.perfil);

    // tenta persistir no Supabase pelo backend — nunca bloqueia nem quebra
    // a importação se ele estiver fora do ar, só muda a frase final
    const persistencia = await persistirImportacaoOfx(conta, movimentos, estado.perfil);

    mostrar(
      (conta ? `${conta.nome}: ` : '')
      + `${novos} ${novos === 1 ? 'movimento novo' : 'movimentos novos'}`
      + (repetidos ? `, ${repetidos} já constavam` : '')
      + `. ${total} no total`
      + (persistencia.ok ? ' — salvo no Supabase.' : ' — em memória até o backend responder.'),
      novos ? 'ok' : 'neutro'
    );

    sincronizar();
  } catch (erro) {
    mostrar(`Não foi possível ler o arquivo: ${erro.message}`, 'erro');
  }
}

/** Traduz um elemento clicado na chamada correta de abrirDetalhe(). */
function despacharDetalhe(alvo) {
  const tipo = alvo.dataset.detalhe;
  const id = alvo.dataset.id;
  if (!tipo) return;

  abrirDetalhe(tipo, {
    id,
    perfil: estado.perfil,
    lente: estado.lenteFinanceira
  });

  // navega para a sub-tela dedicada — sem drawer, sem sobreposição.
  // o id vai junto na URL: sem ele, clicar em uma transação específica do
  // extrato principal abria sempre o detalhe genérico, perdendo qual item
  // foi clicado.
  const caminho = id ? `${tipo}/${encodeURIComponent(id)}` : tipo;
  window.location.hash = `#/financas/detalhe/${caminho}`;
}

const financeiro = {
  id: 'financeiro',
  title: 'Finanças',

  /**
   * Monta a casca uma única vez. As regiões marcadas com data-regiao são
   * as que sincronizar() reescreve.
   * @returns {HTMLElement}
   */
  /**
   * @param {string[]} params ['patrimonio'] em #/financas/patrimonio
   */
  render(params = []) {
    // #/financas -> overview (padrão) | #/financas/fluxo | #/financas/ativos
    // #/financas/conexoes | #/financas/projetos | #/financas/detalhe/<contexto>
    const MAPA_ROTA = {
      fluxo: 'fluxo', ativos: 'patrimonio', conexoes: 'conexoes',
      projetos: 'projetos', detalhe: 'detalhe'
    };
    const sub = MAPA_ROTA[params[0]] ?? 'overview';
    const contexto = params[1] ?? 'fluxo';
    const detalheId = params[2] ?? null;

    const view = document.createElement('section');
    view.dataset.module = this.id;
    view.dataset.sub = sub;
    view.dataset.contexto = contexto;

    const ABAS = [
      ['', 'Overview', 'overview'],
      ['fluxo', 'Fluxo', 'fluxo'],
      ['ativos', 'Ativos', 'patrimonio'],
      ['conexoes', 'Conexões', 'conexoes'],
      ['projetos', 'Projetos', 'projetos']
    ];

    view.innerHTML = `
      <header class="view__head fin-head">
        <div class="fin-head__texto">
          <span class="view__eyebrow" data-regiao="contexto">Pessoa física</span>
          <h1 class="view__title">Finanças</h1>
        </div>

        <div class="fin-head__acoes">
          ${htmlTrocaPerfil(estado.perfil)}
          <button class="btn-lancar" type="button" data-acao="lancar">
            <span class="btn-lancar__cruz" aria-hidden="true"></span>
            Lançar
          </button>
        </div>
      </header>

      ${sub === 'detalhe' ? '' : `
        <nav class="sub-nav" aria-label="Seções de finanças">
          ${ABAS.map(([rota, rotulo, chave]) => `
            <a class="sub-nav__btn" href="#/financas${rota ? '/' + rota : ''}"
               aria-current="${sub === chave ? 'page' : 'false'}">${rotulo}</a>
          `).join('')}
        </nav>
      `}

      <div data-regiao="subtela"></div>
    `;

    // cada sub-tela vem do seu próprio arquivo — exceto Overview e Fluxo,
    // que são deste (financeiro.js), por serem as duas leituras do mesmo dado
    const destino = view.querySelector('[data-regiao="subtela"]');
    destino.appendChild(
      sub === 'patrimonio' ? patrimonio.render()
      : sub === 'conexoes' ? conexoesModulo.render()
      : sub === 'projetos' ? projetosModulo.render()
      : sub === 'detalhe' ? detalhe.render(contexto, detalheId)
      : sub === 'fluxo' ? htmlFluxo()
      : htmlOverview(dadosAtuais, evolucaoAtual, investimentosAtuais)
    );

    return view;
  },

  /**
   * Liga eventos e assinaturas. Tudo por delegação: um listener de clique e
   * um de teclado cobrem a tela inteira, inclusive o conteúdo reescrito.
   * @param {HTMLElement} view
   */
  mount(view, params = []) {
    raiz = view;
    const sub = view.dataset.sub;
    document.title = `${
      { patrimonio: 'Ativos', conexoes: 'Conexões', projetos: 'Projetos', detalhe: 'Detalhamento' }[sub] ?? 'Finanças'
    } · SAN & CO.`;

    // as sub-telas montam o próprio conteúdo; o cabeçalho continua sendo daqui
    if (sub === 'patrimonio') {
      patrimonio.mount(view.querySelector('[data-subtela="patrimonio"]'), params);
    } else if (sub === 'conexoes') {
      conexoesModulo.mount(view.querySelector('[data-subtela="conexoes"]'));
    } else if (sub === 'projetos') {
      projetosModulo.mount(view.querySelector('[data-subtela="projetos"]'));
    } else if (sub === 'detalhe') {
      const detalheId = params[2] ?? null;
      detalhe.mount(view.querySelector('[data-subtela="detalhe"]'), detalheId);
    }

    aoClicar = (evento) => {
      const lente = evento.target.closest('[data-lente]');
      if (lente) return setLenteFinanceira(lente.dataset.lente);

      if (evento.target.closest('[data-acao="trocar-perfil"]')) return alternarPerfil();

      if (evento.target.closest('[data-acao="lancar"]')) {
        // Bloco seguinte: abrir o formulário de lançamento rápido.
        console.info('[financeiro] ação "Lançar" ainda sem destino.');
        return;
      }

      const clicavel = evento.target.closest('[data-clickable="true"]');
      if (clicavel) despacharDetalhe(clicavel);
    };

    // cards e itens de extrato não são <button>: o teclado precisa de ajuda
    aoTeclar = (evento) => {
      if (evento.key !== 'Enter' && evento.key !== ' ') return;
      const clicavel = evento.target.closest('[data-clickable="true"]');
      if (!clicavel) return;
      evento.preventDefault();
      despacharDetalhe(clicavel);
    };

    view.addEventListener('click', aoClicar);
    view.addEventListener('keydown', aoTeclar);

    // seleção pelo seletor de arquivos
    aoEscolherArquivo = (evento) => {
      const campo = evento.target.closest('[data-arquivo-ofx]');
      if (!campo) return;
      tratarArquivoOfx(campo.files?.[0]);
      campo.value = '';   // permite reimportar o mesmo arquivo
    };
    view.addEventListener('change', aoEscolherArquivo);

    // arrastar e soltar sobre a área
    aoArrastar = (evento) => {
      const zona = evento.target.closest('[data-dropzone]');
      if (!zona) return;
      evento.preventDefault();
      zona.dataset.ativo = evento.type === 'dragover' ? 'sim' : 'nao';
      if (evento.type === 'drop') tratarArquivoOfx(evento.dataTransfer?.files?.[0]);
    };
    ['dragover', 'dragleave', 'drop'].forEach((tipo) => {
      view.addEventListener(tipo, aoArrastar);
    });

    cancelarObservadores = [
      observar('perfil', () => sincronizar()),
      observar('lenteFinanceira', () => sincronizar())
    ];

    sincronizar({ animar: false });   // primeira pintura entra sem pulso

    // Atalho de teste: SANCO_FIN.vazio(true) mostra a tela sem dado carregado.
    window.SANCO_FIN = {
      vazio(ligar = true) {
        simularVazio = ligar;
        sincronizar();
        console.info(`[financeiro] modo sem dado ${ligar ? 'ligado' : 'desligado'}.`);
      },
      dados: () => dadosAtuais
    };
  },

  /** Desfaz tudo o que mount() criou. Sem isto, vazamento a cada troca de aba. */
  unmount() {
    if (raiz?.dataset.sub === 'patrimonio') patrimonio.unmount();
    if (raiz?.dataset.sub === 'conexoes') conexoesModulo.unmount();
    if (raiz?.dataset.sub === 'projetos') projetosModulo.unmount();
    if (raiz?.dataset.sub === 'detalhe') detalhe.unmount();

    cancelarObservadores.forEach((cancelar) => cancelar());
    cancelarObservadores = [];

    if (raiz) {
      raiz.removeEventListener('click', aoClicar);
      raiz.removeEventListener('keydown', aoTeclar);
      raiz.removeEventListener('change', aoEscolherArquivo);
      ['dragover', 'dragleave', 'drop'].forEach((tipo) => {
        raiz.removeEventListener(tipo, aoArrastar);
      });
    }

    aoClicar = null;
    aoTeclar = null;
    aoEscolherArquivo = null;
    aoArrastar = null;
    raiz = null;
    delete window.SANCO_FIN;
  }
};

export default financeiro;
