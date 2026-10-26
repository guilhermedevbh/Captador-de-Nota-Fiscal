import React from "react";

type Estado = { erro: Error | null };

// Se algum componente falhar, mostra uma mensagem com opção de recarregar em vez de deixar a tela em branco
export default class ProtecaoErros extends React.Component<{ children: React.ReactNode }, Estado> {
  state: Estado = { erro: null };

  static getDerivedStateFromError(erro: Error): Estado {
    return { erro };
  }

  componentDidCatch(erro: Error, info: React.ErrorInfo) {
    console.error("[Interface] Erro inesperado:", erro, info.componentStack);
  }

  render() {
    if (!this.state.erro) return this.props.children;
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f0f0f0] p-4 text-[13px] text-[#000000]">
        <div className="bg-white border-2 border-[#003366] shadow-xl max-w-lg w-full">
          <div className="bg-[#003366] text-white font-bold px-3 py-2">Captador de Notas Fiscais</div>
          <div className="p-4 flex flex-col gap-3">
            <p className="font-semibold">Ocorreu um erro inesperado nesta tela.</p>
            <p className="text-[#555555]">Seus dados estão salvos. Recarregue a página para continuar.</p>
            <code className="block bg-[#f5f5f5] border border-[#d0d0d0] p-2 text-[11px] break-all">{this.state.erro.message}</code>
            <div className="flex gap-2 justify-end">
              <button type="button" className="px-3 py-1.5 border border-[#707070] bg-[#ececec]" onClick={() => this.setState({ erro: null })}>
                Tentar continuar
              </button>
              <button type="button" className="px-3 py-1.5 border border-[#003366] bg-[#005a9e] text-white font-semibold" onClick={() => window.location.reload()}>
                Recarregar página
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
