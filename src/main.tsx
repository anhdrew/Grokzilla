import ReactDOM from "react-dom/client";
import App from "./App";

function clearBootErrors() {
  document.querySelectorAll("[data-boot-error]").forEach((node) => node.remove());
}

window.addEventListener("error", (event) => {
  clearBootErrors();
  const banner = document.createElement("pre");
  banner.dataset.bootError = "1";
  banner.style.cssText =
    "position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;margin:0;padding:12px;border-radius:10px;background:#fee2e2;color:#991b1b;white-space:pre-wrap;font:12px ui-monospace,monospace;";
  banner.textContent = String(event.error ?? event.message);
  document.body.appendChild(banner);
});

clearBootErrors();
if (import.meta.hot) {
  import.meta.hot.on("vite:beforeUpdate", clearBootErrors);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
