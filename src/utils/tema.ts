// Alternância entre tema claro e escuro (classe `dark` no <html>; o CSS escuro é gerado no build)
export type Tema = "claro" | "escuro";

const CHAVE = "captador_tema";

export const temaAtual = (): Tema =>
  document.documentElement.classList.contains("dark") ? "escuro" : "claro";

export const aplicarTema = (tema: Tema) => {
  document.documentElement.classList.toggle("dark", tema === "escuro");
  try {
    localStorage.setItem(CHAVE, tema);
  } catch {}
};

// Impressão (relatórios, DANFE em tela) sempre no tema claro
let estavaEscuro = false;
window.addEventListener("beforeprint", () => {
  estavaEscuro = document.documentElement.classList.contains("dark");
  document.documentElement.classList.remove("dark");
});
window.addEventListener("afterprint", () => {
  if (estavaEscuro) document.documentElement.classList.add("dark");
});
