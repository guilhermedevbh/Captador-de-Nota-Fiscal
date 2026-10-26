import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import ProtecaoErros from "./components/ProtecaoErros";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ProtecaoErros>
      <App />
    </ProtecaoErros>
  </StrictMode>,
);
