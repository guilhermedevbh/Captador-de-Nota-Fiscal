import { EmpresaSefaz, CnpjConsultaResult, ParsedNfse, NfseMetricas, ParsedNfce, ParsedCte, ModelSchedulersMap, EmpresaMetrics } from "../types";

// =========================================================================
// PONTE WEB COM O SERVIDOR (substitui o ipcRenderer do Electron)
// -------------------------------------------------------------------------
// invoke(canal, ...args) -> POST /api/invoke/:canal
// on(canal, listener)    -> eventos de progresso via Server-Sent Events (/api/events)
// Arquivos gerados no servidor voltam como downloads (ZIP/CSV/XML) ou abrem em nova aba (PDF).
// =========================================================================
type IpcListener = (event: null, payload: any) => void;

interface InvokeResponse {
  result: any;
  downloads?: Array<{ url: string; filename: string }>;
  opens?: Array<{ url: string; filename: string }>;
  folders?: string[];
  error?: string;
}

// Canais que abrem um PDF: a aba é aberta já no clique para não ser barrada pelo bloqueador de pop-ups
const CHANNELS_THAT_OPEN_FILES = new Set([
  "danfe:open-pdf",
  "sefaz:open-nfce-pdf",
  "sefaz:open-cte-pdf",
  "nfse:open-pdf",
]);

const channelListeners = new Map<string, Set<IpcListener>>();
let eventSource: EventSource | null = null;

function ensureEventSource() {
  if (eventSource || typeof window === "undefined" || typeof EventSource === "undefined") return;
  eventSource = new EventSource("/api/events");
  eventSource.onmessage = (msg) => {
    try {
      const { channel, payload } = JSON.parse(msg.data);
      const listeners = channelListeners.get(channel);
      if (listeners) listeners.forEach((listener) => listener(null, payload));
    } catch (_) {}
  };
}

function triggerDownload(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function invokeChannel(channel: string, args: any[], openPaths?: string[]): Promise<any> {
  const pendingTab = CHANNELS_THAT_OPEN_FILES.has(channel) ? window.open("", "_blank") : null;
  try {
    const response = await fetch(`/api/invoke/${encodeURIComponent(channel)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args, openPaths }),
    });
    const data: InvokeResponse = await response.json();
    if (!response.ok) throw new Error(data?.error || `Falha na comunicação com o servidor (${response.status}).`);

    (data.downloads || []).forEach((d) => triggerDownload(d.url, d.filename));

    const opens = (data.opens || []).map((o) => new URL(o.url, window.location.href).href);
    if (opens.length > 0) {
      if (pendingTab && !pendingTab.closed) {
        pendingTab.location.href = opens[0];
      } else {
        window.open(opens[0], "_blank");
      }
      opens.slice(1).forEach((url) => window.open(url, "_blank"));
    } else if (pendingTab) {
      pendingTab.close();
    }

    return data.result;
  } catch (err) {
    if (pendingTab) pendingTab.close();
    throw err;
  }
}

const webIpc = {
  invoke: (channel: string, ...args: any[]) => invokeChannel(channel, args),
  invokeWithPaths: (channel: string, openPaths: string[], ...args: any[]) => invokeChannel(channel, args, openPaths),
  on(channel: string, listener: IpcListener) {
    ensureEventSource();
    if (!channelListeners.has(channel)) channelListeners.set(channel, new Set());
    channelListeners.get(channel)!.add(listener);
  },
  removeListener(channel: string, listener: IpcListener) {
    channelListeners.get(channel)?.delete(listener);
  },
};

function getIpc() {
  return webIpc;
}

// Mantido por compatibilidade: na versão web o backend está sempre disponível pelo servidor
export const isElectron = (): boolean => {
  return true;
};

// Seleciona o certificado A1 no computador do usuário e envia ao servidor; retorna o caminho salvo no servidor
export const selectCertFile = async (_currentPath?: string): Promise<string | null> => {
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pfx,.p12";
    input.style.display = "none";
    let settled = false;
    const finish = (f: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(f);
    };
    input.addEventListener("change", () => finish(input.files?.[0] || null));
    input.addEventListener("cancel", () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
  if (!file) return null;
  return await uploadCertFile(file);
};

// Envia um certificado A1 (selecionado ou arrastado) ao servidor; retorna o caminho salvo no servidor
export const uploadCertFile = async (file: File): Promise<string | null> => {
  try {
    const response = await fetch(`/api/upload-cert?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || "Falha ao enviar o certificado.");
    return data.path as string;
  } catch (err: any) {
    alert(`Não foi possível enviar o certificado: ${err?.message || err}`);
    return null;
  }
};

export interface NetworkCertItem {
  name: string;
  fullPath: string;
  extractedPassword?: string;
  dir: string;
}

export const listNetworkCerts = async (): Promise<{
  success: boolean;
  dir?: string;
  certs?: NetworkCertItem[];
  error?: string;
}> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:list-network-certs");
};

export const testCert = async (certPath: string, password: string) => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:test-cert", { certPath, password });
};

export const syncCompanySefaz = async (
  company: EmpresaSefaz,
  options?: { resetNsu?: boolean; clearManifestations?: boolean; targetNsu?: string; forceSync?: boolean } | any
) => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };

  // Higieniza para garantir que apenas tipos primitivos serializáveis sejam enviados pelo IPC
  const safeCompany = {
    id: String(company?.id || ""),
    razaoSocial: String(company?.razaoSocial || ""),
    cnpj: String(company?.cnpj || ""),
    uf: String(company?.uf || ""),
    regime: company?.regime,
    certPath: String(company?.certPath || ""),
    password: company?.password ? String(company.password) : "",
    ambiente: Number(company?.ambiente || 1),
  };

  const safeOptions: any = {};
  if (options && typeof options === "object" && !options.nativeEvent && !options._reactName) {
    if (options.resetNsu !== undefined) safeOptions.resetNsu = Boolean(options.resetNsu);
    if (options.clearManifestations !== undefined) safeOptions.clearManifestations = Boolean(options.clearManifestations);
    if (options.targetNsu !== undefined && options.targetNsu !== null) safeOptions.targetNsu = String(options.targetNsu);
    if (options.forceSync !== undefined) safeOptions.forceSync = Boolean(options.forceSync);
  }

  return await ipc.invoke("sefaz:sync-company", { company: safeCompany, ...safeOptions });
};

export const getCompanySefazState = async (cnpj: string, razaoSocial?: string) => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:get-company-state", { cnpj, razaoSocial });
};

export const resetCompanyNsu = async (
  cnpj: string,
  targetNsu: string = "0",
  clearManifestations: boolean = false,
  razaoSocial?: string,
  clearFiles: boolean = false
) => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:reset-nsu", { cnpj, targetNsu, clearManifestations, razaoSocial, clearFiles });
};

export const listAvailableMonths = async (cnpj: string, razaoSocial?: string): Promise<string[]> => {
  const ipc = getIpc();
  if (!ipc) return [];
  const res = await ipc.invoke("sefaz:list-months", { cnpj, razaoSocial });
  return res.success ? res.months : [];
};

export interface CapturedNfeMetadata {
  name: string;
  fullPath: string;
  folder: string;
  chNFe: string;
  nNF: string;
  serie: string;
  dhEmi: string;
  formattedDate: string;
  emitente: string;
  cnpjEmitente: string;
  ufRem: string;
  destinatario: string;
  cnpjDest: string;
  ufDest: string;
  vNF: number;
  isInterestadual: boolean;
  content?: string;
}

export const listCompanyXmls = async (
  cnpj: string,
  yearMonth?: string,
  razaoSocial?: string
): Promise<CapturedNfeMetadata[]> => {
  const ipc = getIpc();
  if (!ipc) return [];
  const res = await ipc.invoke("sefaz:list-xmls", { cnpj, yearMonth, razaoSocial });
  return res.success ? res.xmls : [];
};

export const readXmlsContent = async (
  filePaths: string[]
): Promise<Array<{ name: string; fullPath: string; content: string }>> => {
  const ipc = getIpc();
  if (!ipc) return [];
  const res = await ipc.invoke("sefaz:read-xmls-content", { filePaths });
  return res.success ? res.results : [];
};

export const openDanfePdf = async (cnpj: string, chNFe: string, yearMonth?: string, razaoSocial?: string) => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("danfe:open-pdf", { cnpj, chNFe, yearMonth, razaoSocial });
};

export const onSyncProgress = (callback: (info: { status: string; message: string }) => void) => {
  const ipc = getIpc();
  if (!ipc) return () => {};

  const listener = (_event: any, info: any) => {
    callback(info);
  };

  ipc.on("sefaz:sync-progress", listener);
  return () => {
    ipc.removeListener("sefaz:sync-progress", listener);
  };
};

export const exportCompetencia = async (
  cnpj: string,
  companyName: string,
  yearMonth: string,
  exportType: "all" | "xml" | "pdf",
  options?: { specificKeys?: string[]; startDate?: string; endDate?: string; periodLabel?: string }
): Promise<{ success: boolean; canceled?: boolean; fileCount?: number; targetZipPath?: string; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:export-competencia", { cnpj, companyName, yearMonth, exportType, ...options });
};

export const openCompanyFolder = async (cnpj: string, subfolder?: string, razaoSocial?: string) => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:open-folder", { cnpj, subfolder, razaoSocial });
};

export const saveSingleXml = async (cnpj: string, chNFe: string, yearMonth?: string) => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:save-single-xml", { cnpj, chNFe, yearMonth });
};

export const consultarCnpj = async (cnpj: string, forceRefresh: boolean = false): Promise<CnpjConsultaResult> => {
  const ipc = getIpc();
  if (!ipc) {
    return { sucesso: false, cnpj, erro: "Servidor indisponível." };
  }
  return await ipc.invoke("cnpj:consultar", { cnpj, forceRefresh });
};

export const consultarCnpjsLote = async (
  cnpjs: string[],
  forceRefresh: boolean = false
): Promise<Record<string, CnpjConsultaResult>> => {
  const ipc = getIpc();
  if (!ipc) return {};
  return await ipc.invoke("cnpj:consultar-lote", { cnpjs, forceRefresh });
};

export const obterCnpjCache = async (): Promise<Record<string, CnpjConsultaResult>> => {
  const ipc = getIpc();
  if (!ipc) return {};
  return await ipc.invoke("cnpj:obter-cache");
};

export const onCnpjConsultaProgress = (
  callback: (info: {
    current: number;
    total: number;
    cnpj: string;
    razao?: string;
    isSimples?: boolean;
    statusSimples?: string;
  }) => void
) => {
  const ipc = getIpc();
  if (!ipc) return () => {};

  const listener = (_event: any, info: any) => {
    callback(info);
  };

  ipc.on("cnpj:consultar-progresso", listener);
  return () => {
    ipc.removeListener("cnpj:consultar-progresso", listener);
  };
};

export const fetchNfeByChave = async (company: EmpresaSefaz, chNFe: string) => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };

  const safeCompany = {
    id: String(company?.id || ""),
    razaoSocial: String(company?.razaoSocial || ""),
    cnpj: String(company?.cnpj || ""),
    uf: String(company?.uf || ""),
    regime: company?.regime,
    certPath: String(company?.certPath || ""),
    password: company?.password ? String(company.password) : "",
    ambiente: Number(company?.ambiente || 1),
  };

  return await ipc.invoke("sefaz:fetch-by-chave", {
    company: safeCompany,
    chNFe: String(chNFe || "").replace(/\D/g, ""),
  });
};

export interface AppSettings {
  customStorageDir: string;
  defaultStorageDir: string;
  modelSchedulers?: ModelSchedulersMap;
  scheduler: {
    enabled: boolean;
    time: string;
    lastRunDate?: string | null;
  };
  nfseScheduler?: {
    enabled: boolean;
    time: string;
    lastRunDate?: string | null;
  };
}

export const getAppSettings = async (): Promise<AppSettings | null> => {
  const ipc = getIpc();
  if (!ipc) return null;
  return await ipc.invoke("settings:get");
};

export const selectStorageFolder = async (): Promise<{
  success: boolean;
  customStorageDir?: string;
  canceled?: boolean;
  error?: string;
}> => {
  const ipc = getIpc();
  const current = (await getAppSettings())?.customStorageDir || "";
  const selectedDir = window.prompt(
    "Informe o caminho da pasta (no computador onde o servidor está rodando) para armazenar as notas fiscais:",
    current
  );
  if (!selectedDir || !selectedDir.trim()) return { success: false, canceled: true };
  return await ipc.invokeWithPaths("settings:select-folder", [selectedDir.trim()]);
};

export const openStorageFolder = async (): Promise<{ success: boolean; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("settings:open-storage-folder");
};

export const saveSchedulerSettings = async (scheduler: {
  enabled: boolean;
  time: string;
}): Promise<{ success: boolean; scheduler?: any; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("settings:save-scheduler", scheduler);
};

export const saveNfseSchedulerSettings = async (nfseScheduler: {
  enabled: boolean;
  time: string;
}): Promise<{ success: boolean; nfseScheduler?: any; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("settings:save-nfse-scheduler", nfseScheduler);
};

export const saveModelSchedulersSettings = async (
  modelSchedulers: ModelSchedulersMap
): Promise<{ success: boolean; modelSchedulers?: ModelSchedulersMap; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("settings:save-model-schedulers", modelSchedulers);
};

export const syncAllCompanies = async (
  companies: EmpresaSefaz[]
): Promise<{ success: boolean; total?: number; results?: any[]; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };

  const safeCompanies = (companies || []).map((c) => ({
    id: String(c?.id || ""),
    razaoSocial: String(c?.razaoSocial || ""),
    cnpj: String(c?.cnpj || ""),
    uf: String(c?.uf || ""),
    regime: c?.regime,
    certPath: String(c?.certPath || ""),
    password: c?.password ? String(c.password) : "",
    ambiente: Number(c?.ambiente || 1),
    modelosHabilitados: c?.modelosHabilitados,
  }));

  return await ipc.invoke("sefaz:sync-all", { companies: safeCompanies });
};

export const onSyncAllProgress = (callback: (info: any) => void) => {
  const ipc = getIpc();
  if (!ipc) return () => {};

  const listener = (_event: any, info: any) => {
    callback(info);
  };

  ipc.on("sefaz:sync-all-progress", listener);
  return () => {
    ipc.removeListener("sefaz:sync-all-progress", listener);
  };
};

export const onSchedulerTrigger = (callback: (payload?: { type?: "sefaz" | "nfe" | "nfce" | "cte" | "nfse"; time?: string }) => void) => {
  const ipc = getIpc();
  if (!ipc) return () => {};

  const listener = (_event: any, payload?: any) => {
    callback(payload);
  };

  ipc.on("scheduler:trigger-sync", listener);
  return () => {
    ipc.removeListener("scheduler:trigger-sync", listener);
  };
};

export const syncCompanyNfce = async (
  company: EmpresaSefaz,
  options?: { diasRetroativos?: number; forceFullScan?: boolean }
): Promise<{ success: boolean; result?: any; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };

  const safeCompany = {
    id: String(company?.id || ""),
    razaoSocial: String(company?.razaoSocial || ""),
    cnpj: String(company?.cnpj || ""),
    uf: String(company?.uf || ""),
    regime: company?.regime,
    certPath: String(company?.certPath || ""),
    password: company?.password ? String(company.password) : "",
    ambiente: Number(company?.ambiente || 1),
    modelosHabilitados: company?.modelosHabilitados,
  };

  return await ipc.invoke("sefaz:sync-nfce", {
    company: safeCompany,
    diasRetroativos: options?.diasRetroativos || 90,
    forceFullScan: options?.forceFullScan ?? false,
  });
};

export const listCompanyNfceXmls = async (
  cnpj: string,
  razaoSocial?: string,
  yearMonth?: string
): Promise<{ success: boolean; list: ParsedNfce[]; months: string[]; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, list: [], months: [], error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:list-nfce", { cnpj, razaoSocial, yearMonth });
};

export const openCompanyNfceFolder = async (
  cnpj: string,
  razaoSocial?: string
): Promise<{ success: boolean; dir?: string; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:open-nfce-folder", { cnpj, razaoSocial });
};

export const onNfceProgress = (callback: (info: any) => void) => {
  const ipc = getIpc();
  if (!ipc) return () => {};

  const listener = (_event: any, info: any) => {
    callback(info);
  };

  ipc.on("sefaz:sync-nfce-progress", listener);
  return () => {
    ipc.removeListener("sefaz:sync-nfce-progress", listener);
  };
};

export const openNfceDanfePdf = async (
  pdfPath?: string,
  xmlPath?: string
): Promise<{ success: boolean; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:open-nfce-pdf", { pdfPath, xmlPath });
};

export const exportNfceCompetencia = async (
  cnpj: string,
  razaoSocial?: string,
  yearMonth?: string,
  exportType: "all" | "xml" | "pdf" = "all"
): Promise<{ success: boolean; canceled?: boolean; fileCount?: number; targetZipPath?: string; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:export-nfce-competencia", { cnpj, razaoSocial, yearMonth, exportType });
};

export const saveSingleNfceXml = async (
  cnpj: string,
  chNFe: string,
  razaoSocial?: string,
  xmlPath?: string
): Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:save-single-nfce-xml", { cnpj, chNFe, razaoSocial, xmlPath });
};

export const getCompanyNfceCacheState = async (
  cnpj: string,
  razaoSocial?: string
): Promise<{ success: boolean; result?: { lastExecution: string | null; lastSyncTime: string | null; downloadedKeys: Record<string, any> }; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:get-nfce-cache-state", { cnpj, razaoSocial });
};

export const resetCompanyNfceCache = async (
  cnpj: string,
  razaoSocial?: string,
  clearFiles: boolean = false
): Promise<{ success: boolean; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:reset-nfce-cache", { cnpj, razaoSocial, clearFiles });
};

export const syncCompanyCte = async (
  company: EmpresaSefaz
): Promise<{ success: boolean; result?: any; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };

  const safeCompany = {
    id: String(company?.id || ""),
    razaoSocial: String(company?.razaoSocial || ""),
    cnpj: String(company?.cnpj || ""),
    uf: String(company?.uf || ""),
    regime: company?.regime,
    certPath: String(company?.certPath || ""),
    password: company?.password ? String(company.password) : "",
    ambiente: Number(company?.ambiente || 1),
  };

  return await ipc.invoke("sefaz:sync-cte", { company: safeCompany });
};

export const listCompanyCteXmls = async (
  cnpj: string,
  razaoSocial?: string,
  yearMonth?: string
): Promise<{ success: boolean; list: ParsedCte[]; months: string[]; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, list: [], months: [], error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:list-cte", { cnpj, razaoSocial, yearMonth });
};

export const openCompanyCteFolder = async (
  cnpj: string,
  razaoSocial?: string
): Promise<{ success: boolean; dir?: string; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:open-cte-folder", { cnpj, razaoSocial });
};

export const onCteProgress = (callback: (info: any) => void) => {
  const ipc = getIpc();
  if (!ipc) return () => {};

  const listener = (_event: any, info: any) => {
    callback(info);
  };

  ipc.on("sefaz:sync-cte-progress", listener);
  return () => {
    ipc.removeListener("sefaz:sync-cte-progress", listener);
  };
};

export const openCteDactePdf = async (
  pdfPath?: string,
  xmlPath?: string
): Promise<{ success: boolean; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:open-cte-pdf", { pdfPath, xmlPath });
};

export const exportCteCompetencia = async (
  cnpj: string,
  razaoSocial?: string,
  yearMonth?: string,
  exportType: "all" | "xml" | "pdf" = "all"
): Promise<{ success: boolean; canceled?: boolean; fileCount?: number; targetZipPath?: string; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:export-cte-competencia", { cnpj, razaoSocial, yearMonth, exportType });
};

export const saveSingleCteXml = async (
  cnpj: string,
  chCTe: string,
  razaoSocial?: string,
  xmlPath?: string
): Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:save-single-cte-xml", { cnpj, chCTe, razaoSocial, xmlPath });
};

export const getCompanyCteNsuState = async (
  cnpj: string,
  razaoSocial?: string
): Promise<{ success: boolean; result?: { ultimoNsuCte: string; downloadedKeys: Record<string, any>; lastSync?: string }; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:get-cte-nsu-state", { cnpj, razaoSocial });
};

export const resetCompanyCteNsu = async (
  cnpj: string,
  razaoSocial?: string,
  targetNsu: string = "0",
  clearFiles: boolean = false
): Promise<{ success: boolean; targetNsu?: string; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:reset-cte-nsu", { cnpj, razaoSocial, targetNsu, clearFiles });
};

export const getAutoStart = async (): Promise<boolean> => {
  const ipc = getIpc();
  if (!ipc) return false;
  try {
    return await ipc.invoke("app:get-auto-start");
  } catch (e) {
    return false;
  }
};

export const setAutoStart = async (enabled: boolean): Promise<boolean> => {
  const ipc = getIpc();
  if (!ipc) return false;
  try {
    const res = await ipc.invoke("app:set-auto-start", enabled);
    return !!res.openAtLogin;
  } catch (e) {
    return false;
  }
};

// =========================================================================
// MÉTODOS DE INTEGRAÇÃO DO MÓDULO NFS-E (PORTAL NACIONAL & SP)
// =========================================================================

export interface NfseSyncProgressPayload {
  message: string;
  type?: "info" | "warn" | "error";
  timestamp?: string;
  currentNsu?: number;
  docsCount?: number;
  cnpj?: string;
}

export const syncCompanyNfse = async (
  company: EmpresaSefaz,
  targetNsu?: string | number
): Promise<{ success: boolean; totalDocsBaixados?: number; novoNsu?: number; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("nfse:sync-company", { company, targetNsu });
};

export const syncSpNfse = async (
  company: EmpresaSefaz,
  params?: { ano?: string | number; mes?: string | number; dtInicio?: string; dtFim?: string }
): Promise<{ success: boolean; totalBaixadas?: number; totalCanceladas?: number; logs?: string[]; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("nfse:sync-sp", { company, params });
};

export const getNfseMetrics = async (
  cnpj: string,
  razaoSocial?: string,
  ano?: string,
  mes?: string,
  tipo?: string
): Promise<{ success: boolean; metricas?: NfseMetricas; totalNotas?: number; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("nfse:get-metrics", { cnpj, razaoSocial, ano, mes, tipo });
};

export const listNfseNotas = async (
  cnpj: string,
  razaoSocial?: string,
  ano?: string,
  mes?: string,
  tipo?: string
): Promise<{ success: boolean; notas: ParsedNfse[]; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, notas: [], error: "Servidor indisponível." };
  return await ipc.invoke("nfse:list-notas", { cnpj, razaoSocial, ano, mes, tipo });
};

export const getNfseState = async (
  cnpj: string,
  razaoSocial?: string
): Promise<{ success: boolean; state?: { ultimoNsuNfse: number; lastSync?: string }; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("nfse:get-state", { cnpj, razaoSocial });
};

export const resetNfseNsu = async (
  cnpj: string,
  razaoSocial?: string,
  targetNsu: number = 0
): Promise<{ success: boolean; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("nfse:reset-nsu", { cnpj, razaoSocial, targetNsu });
};

export const exportNfseCsv = async (
  cnpj: string,
  razaoSocial?: string,
  ano?: string,
  mes?: string,
  tipo?: string,
  dataInicio?: string,
  dataFim?: string
): Promise<{ success: boolean; filePath?: string; canceled?: boolean; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("nfse:export-csv", { cnpj, razaoSocial, ano, mes, tipo, dataInicio, dataFim });
};

export const downloadNfseZip = async (
  cnpj: string,
  razaoSocial?: string,
  ano?: string,
  mes?: string,
  tipo?: string,
  dataInicio?: string,
  dataFim?: string
): Promise<{ success: boolean; filePath?: string; canceled?: boolean; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("nfse:download-zip", { cnpj, razaoSocial, ano, mes, tipo, dataInicio, dataFim });
};

export const openNfsePdf = async (
  pdfPath?: string,
  xmlPath?: string
): Promise<{ success: boolean; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("nfse:open-pdf", { pdfPath, xmlPath });
};

export const saveNfseXml = async (
  xmlPath: string,
  defaultName?: string
): Promise<{ success: boolean; filePath?: string; canceled?: boolean; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("nfse:save-xml", { xmlPath, defaultName });
};

export const openNfseFolder = async (
  cnpj: string,
  razaoSocial?: string
): Promise<{ success: boolean; dir?: string; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("nfse:open-folder", { cnpj, razaoSocial });
};

export const onNfseProgress = (callback: (info: NfseSyncProgressPayload) => void) => {
  const ipc = getIpc();
  if (!ipc) return () => {};

  const listener = (_event: any, data: NfseSyncProgressPayload) => {
    callback(data);
  };

  ipc.on("nfse:sync-progress", listener);
  return () => {
    ipc.removeListener("nfse:sync-progress", listener);
  };
};

export const resetAllModelsNsu = async (options: {
  scope: "single" | "all";
  cnpj?: string;
  razaoSocial?: string;
  companies?: EmpresaSefaz[];
  clearFiles?: boolean;
  clearManifestations?: boolean;
}): Promise<{ success: boolean; total?: number; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("sefaz:reset-all-models-nsu", options);
};

export const saveCsvFile = async (
  defaultFilename: string,
  content: string,
  title: string = "Salvar Relatório em Planilha (.csv)"
): Promise<{ success: boolean; filePath?: string; canceled?: boolean; error?: string }> => {
  // Na versão web o arquivo é gerado e baixado diretamente pelo navegador
  try {
    const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, defaultFilename);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { success: true, filePath: defaultFilename };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
};

export const exportarExcelCompleto = async (params: {
  cnpj: string;
  razaoSocial: string;
  dataInicio?: string;
  dataFim?: string;
  direcao?: "todas" | "emitidas" | "recebidas";
  tipos?: string[];
  ano?: string;
  mes?: string;
}): Promise<{
  success?: boolean;
  canceled?: boolean;
  error?: string;
  totalDocumentos?: number;
  totalEventos?: number;
  totalNotas?: number;
  totalItens?: number;
  totalCtes?: number;
  totalNfses?: number;
}> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("relatorio:excel-completo", params);
};

export const exportDiagnostics = async (
  activeEmpresa?: EmpresaSefaz | null
): Promise<{ success: boolean; filePath?: string; canceled?: boolean; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível." };
  return await ipc.invoke("app:export-diagnostics", { activeEmpresa });
};

export const saveHtmlDashboard = async (
  defaultFilename: string,
  htmlContent: string,
  title: string = "Salvar Dashboard Executivo (.html)",
  autoOpen: boolean = true
): Promise<{ success: boolean; filePath?: string; canceled?: boolean; error?: string }> => {
  // Na versão web o dashboard é baixado e, se solicitado, aberto em nova aba
  try {
    const blob = new Blob([htmlContent], { type: "text/html;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, defaultFilename);
    if (autoOpen) window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { success: true, filePath: defaultFilename };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
};

export const getCompaniesMetrics = async (
  companies: EmpresaSefaz[]
): Promise<{ success: boolean; metrics?: EmpresaMetrics[]; error?: string }> => {
  const ipc = getIpc();
  if (!ipc) return { success: false, error: "Servidor indisponível.", metrics: [] };
  const safeCompanies = (companies || []).map((c) => ({
    id: String(c?.id || ""),
    razaoSocial: String(c?.razaoSocial || ""),
    cnpj: String(c?.cnpj || ""),
    uf: String(c?.uf || ""),
    regime: c?.regime,
    certPath: String(c?.certPath || ""),
    password: c?.password ? String(c.password) : "",
    ambiente: Number(c?.ambiente || 1),
    certInfo: c?.certInfo,
    modelosHabilitados: c?.modelosHabilitados,
  }));
  return await ipc.invoke("app:get-companies-metrics", { companies: safeCompanies });
};

