import "@solana/wallet-adapter-react-ui/styles.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./app.css";

const el = document.getElementById("root");
if (!el) {
  throw new Error("Missing #root");
}

ReactDOM.createRoot(el).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
