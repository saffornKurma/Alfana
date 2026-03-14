"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
const vscode = __importStar(require("vscode"));
const parser_1 = require("./parser");
function activate(ctx) {
    // Sidebar Webview View
    const provider = new AlfWebviewProvider(ctx);
    ctx.subscriptions.push(vscode.window.registerWebviewViewProvider('alfAnalyzer.view', provider));
    // Command Palette: analyze current editor content
    ctx.subscriptions.push(vscode.commands.registerCommand('alfAnalyzer.analyzeCurrent', async () => {
        const doc = vscode.window.activeTextEditor?.document;
        if (!doc) {
            vscode.window.showWarningMessage('No active editor to analyze.');
            return;
        }
        const analysis = (0, parser_1.analyzeAlfText)(doc.getText());
        showResults(analysis);
        // also push to sidebar if open
        provider.postAnalysis(analysis);
    }));
}
class AlfWebviewProvider {
    ctx;
    _view;
    constructor(ctx) {
        this.ctx = ctx;
    }
    resolveWebviewView(view) {
        this._view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = getHtml(this.ctx);
        view.webview.onDidReceiveMessage((msg) => {
            if (msg?.type === 'analyze-text') {
                const analysis = (0, parser_1.analyzeAlfText)(msg.text ?? '');
                this.postAnalysis(analysis);
            }
        });
    }
    postAnalysis(analysis) {
        this._view?.webview.postMessage({ type: 'analysis-done', payload: analysis });
    }
}
function showResults(a) {
    const groups = a.groups.slice(0, 5).map((g, i) => `#${i + 1} x${g.count} – ${g.topFrame ?? 'n/a'}`);
    vscode.window.showInformationMessage(groups.length ? `Found ${a.groups.length} error groups. Top: ${groups.join('; ')}` : 'No ERROR/FATAL groups found.');
}
function getHtml(ctx) {
    const codicons = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'codicon.css'); // optional if you add codicons locally
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">`;
    return /* html */ `
  <html>
    <head>
      ${csp}
      <style>
        body { font-family: var(--vscode-font-family); padding: 8px; }
        textarea { width: 100%; height: 160px; }
        .btn { margin-top: 8px; }
        .group { padding: 6px 0; border-bottom: 1px solid var(--vscode-menu-separatorBackground); }
        pre { white-space: pre-wrap; }
      </style>
    </head>
    <body>
      <h3>ALF Log Analysis</h3>
      <textarea id="log" placeholder="Paste ALF logs here…"></textarea>
      <div><button class="btn" id="btnAnalyze">Analyze</button></div>
      <div id="out"></div>
      <script>
        const vscode = acquireVsCodeApi();
        const log = document.getElementById('log');
        const out = document.getElementById('out');
        document.getElementById('btnAnalyze').onclick = () => {
          vscode.postMessage({ type: 'analyze-text', text: log.value });
        };
        window.addEventListener('message', (e) => {
          const { type, payload } = e.data || {};
          if (type === 'analysis-done') {
            const groups = payload.groups || [];
            if (!groups.length) { out.innerHTML = '<p>No ERROR/FATAL groups found.</p>'; return; }
            out.innerHTML = groups.slice(0, 20).map((g, i) => {
              const sample = (g.samples && g.samples[0]) ? g.samples[0] : null;
              const msg = sample ? sample.msg : '';
              const frame = g.topFrame || 'n/a';
              return '<div class="group"><b>#'+(i+1)+'</b> x'+g.count+'<br/>Top frame: <code>'+frame+'</code><pre>'+escapeHtml(msg)+'</pre></div>';
            }).join('');
          }
        });
        function escapeHtml(s) { return (s||'').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
      </script>
    </body>
  </html>`;
}
//# sourceMappingURL=extension.js.map