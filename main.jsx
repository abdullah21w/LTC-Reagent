import React from "react";
import ReactDOM from "react-dom/client";

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("App crashed:", error, info);
  }
  render() {
    if (this.state.error) return <CrashScreen error={this.state.error} />;
    return this.props.children;
  }
}

function CrashScreen({ error }) {
  const message = (error && error.message) || String(error);
  const stack = (error && error.stack) || "";
  const fullText = `${message}\n\n${stack}`;
  const [copied, setCopied] = React.useState(false);

  function copy() {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(fullText).then(() => setCopied(true)).catch(() => setCopied(false));
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "#FBEAE6", color: "#1B2B2E", fontFamily: "'IBM Plex Mono', monospace", padding: 18, boxSizing: "border-box" }}>
      <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4, color: "#C1432B" }}>The app hit an error</div>
      <div style={{ fontSize: 13, color: "#8A2E1F", marginBottom: 14 }}>
        Tap the box below to select the text, or use the button to copy it, then send it over so it can be fixed.
      </div>
      <textarea
        readOnly
        value={fullText}
        onClick={(e) => e.target.select()}
        style={{ width: "100%", minHeight: 240, fontSize: 12, lineHeight: 1.5, padding: 12, border: "1px solid #C1432B", borderRadius: 8, boxSizing: "border-box", background: "#fff", color: "#1B2B2E", fontFamily: "'IBM Plex Mono', monospace" }}
      />
      <button
        onClick={copy}
        style={{ marginTop: 12, background: "#C1432B", color: "#fff", border: "none", borderRadius: 8, padding: "11px 18px", fontWeight: 700, fontSize: 14 }}
      >
        {copied ? "Copied ✓" : "Copy error"}
      </button>
      <button
        onClick={() => window.location.reload()}
        style={{ marginTop: 12, marginLeft: 10, background: "transparent", color: "#8A2E1F", border: "1px solid #C1432B", borderRadius: 8, padding: "11px 18px", fontWeight: 700, fontSize: 14 }}
      >
        Reload
      </button>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));

function renderCrash(error) {
  root.render(<CrashScreen error={error} />);
}

window.addEventListener("error", (e) => {
  renderCrash(e.error || new Error(e.message || "Unknown error"));
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason;
  renderCrash(reason instanceof Error ? reason : new Error(String(reason)));
});

// App.jsx (and its imports, like supabaseClient.js) are loaded dynamically so that
// any error thrown while loading them — for example missing Supabase env vars —
// is caught here and shown on screen instead of leaving a blank white page.
import("./App.jsx")
  .then(({ default: App }) => {
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>
    );
  })
  .catch((err) => {
    renderCrash(err);
  });
