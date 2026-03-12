// Полифилл Buffer для @solana/web3.js в браузере
import { Buffer } from "buffer";
(window as any).global = window;
(window as any).Buffer = Buffer;

import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Принудительно включаем тёмную тему — биржевой стиль
document.documentElement.classList.add("dark");

createRoot(document.getElementById("root")!).render(<App />);
