import * as vscode from 'vscode';
import { analyzeAlfText, Analysis } from './parser';

/* ============================================================
   Defaults & secrets storage
   ============================================================ */
const DEFAULTS_KEY = 'alf.defaults';

type AlfDefaults = {
  baseUrl?: string;
  username?: string;
  lastSearchId?: string;
  rememberPassword?: boolean;
};

async function getDefaults(ctx: vscode.ExtensionContext): Promise<AlfDefaults> {
  return (ctx.globalState.get<AlfDefaults>(DEFAULTS_KEY)) ?? {};
}

async function saveDefaults(ctx: vscode.ExtensionContext, v: Partial<AlfDefaults>) {
  const cur = await getDefaults(ctx);
  await ctx.globalState.update(DEFAULTS_KEY, { ...cur, ...v });
}

/* ============================================================
   ALF API client (minimal: login + getResult)
   ============================================================ */
class AlfApi {
  private baseUrl: string;
  private cookie: string | null = null; // "JSESSIONID=..."

  constructor(baseUrl: string) {
    const withSlash = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    this.baseUrl = withSlash;
  }

  private url(path: string) {
    return new URL(path, this.baseUrl).toString();
  }

  async login(username: string, password: string) {
    const res = await fetch(this.url('auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password })
    });
    if (!res.ok) throw new Error(`Login failed: HTTP ${res.status}`);

    const setCookie = res.headers.get('set-cookie') || '';
    const m = /JSESSIONID=([^;]+)/i.exec(setCookie);
    if (!m) throw new Error('Login succeeded but JSESSIONID cookie not found.');
    this.cookie = `JSESSIONID=${m[1]}`;
  }

  async getResult(searchId: string, limit = 10000, offset = 0): Promise<string> {
    if (!this.cookie) throw new Error('Not logged in.');
    const res = await fetch(
      this.url(`rest/search/result?searchId=${encodeURIComponent(searchId)}&offset=${offset}&limit=${limit}`),
      { headers: { 'Cookie': this.cookie, 'Accept': 'application/json, text/plain, */*' } }
    );
    if (!res.ok) throw new Error(`Fetch result failed: HTTP ${res.status}`);

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data: any = await res.json();
      const items = Array.isArray(data) ? data : (Array.isArray(data?.results) ? data.results : []);
      const payloads = items
        .map((it: any) => it?.payload ?? it?.message ?? it?.msg ?? '')
        .filter((s: string) => s && typeof s === 'string');
      return payloads.join('\n\n---\n\n');
    }
    return await res.text();
  }
}

/* ============================================================
   Extension activation
   ============================================================ */
export function activate(context: vscode.ExtensionContext) {
  const provider = new AlfWebviewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('alfAnalyzer.view', provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('alfAnalyzer.analyzeCurrent', async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc) { vscode.window.showWarningMessage('No active editor to analyze.'); return; }
      const analysis = analyzeAlfText(doc.getText());
      provider.postAnalysis(analysis);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('alfAnalyzer.explainWithAI', async () => {
      provider.explainWithAI();
    })
  );
}

/* ============================================================
   Webview Provider  (with "ready" -> "prefill" handshake)
   ============================================================ */
class AlfWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private lastAnalysis: Analysis | null = null;
  private alf: AlfApi | null = null;
  private hasSentPrefill = false; // ensure we send prefill exactly once after "ready"

  constructor(private ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')]
    };

    // Load the minimal HTML
    const htmlUri = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'panel.html');
    const panelSrc = view.webview.asWebviewUri(htmlUri);

    view.webview.html = `
      <!DOCTYPE html>
      <html><body>
        <script>
          // Load external HTML content
          fetch("${panelSrc}")
            .then(r=>r.text())
            .then(h=>{
              document.open(); document.write(h); document.close();
              // IMPORTANT: as soon as the HTML is written, signal "ready"
              try {
                const api = acquireVsCodeApi();
                // Most pages attach their event listeners synchronously.
                // Delay a tick to ensure the page's own script has run.
                setTimeout(()=>api.postMessage({ type: 'ready' }), 0);
              } catch {}
            });
        </script>
      </body></html>`;

    view.webview.onDidReceiveMessage(async (msg) => {
      try {
        /* ---------- Handshake: webview ready -> send prefill ---------- */
        if (msg?.type === 'ready' && !this.hasSentPrefill) {
          this.hasSentPrefill = true;
          const defs = await getDefaults(this.ctx);
          const savedPwd = defs.rememberPassword ? await this.ctx.secrets.get('alf.password') : undefined;
          this.view?.webview.postMessage({
            type: 'prefill',
            defaults: defs,
            password: savedPwd || ''
          });
          return;
        }

        /* ---------- Host clipboard bridge ---------- */
        if (msg?.type === 'read-clipboard') {
          try {
            const text = await vscode.env.clipboard.readText();
            this.view?.webview.postMessage({ type: 'clipboard', target: String(msg.target || ''), text });
          } catch (e: any) {
            this.view?.webview.postMessage({
              type: 'clipboard-error',
              target: String(msg.target || ''),
              message: e?.message || String(e)
            });
          }
          return;
        }

        /* ---------- Save defaults & secrets ---------- */
        if (msg?.type === 'save-defaults') {
          await saveDefaults(this.ctx, {
            baseUrl: String(msg.baseUrl ?? ''),
            username: String(msg.username ?? ''),
            lastSearchId: String(msg.lastSearchId ?? ''),
            rememberPassword: !!msg.rememberPassword
          });
          if (msg.rememberPassword && typeof msg.password === 'string') {
            await this.ctx.secrets.store('alf.password', msg.password);
          }
          if (!msg.rememberPassword) {
            await this.ctx.secrets.delete('alf.password');
          }
          return;
        }

        if (msg?.type === 'save-password') {
          if (msg.rememberPassword) {
            await this.ctx.secrets.store('alf.password', String(msg.password ?? ''));
          } else {
            await this.ctx.secrets.delete('alf.password');
          }
          await saveDefaults(this.ctx, { rememberPassword: !!msg.rememberPassword });
          return;
        }

        if (msg?.type === 'save-last-search-id') {
          await saveDefaults(this.ctx, { lastSearchId: String(msg.searchId ?? '') });
          return;
        }

        /* ---------- Login ---------- */
        if (msg?.type === 'alf-login') {
          const baseUrl = String(msg.baseUrl || '');
          const user = String(msg.username || '');
          const pass = String(msg.password || '');

          if (!baseUrl) throw new Error('Base URL is required.');
          if (!user) throw new Error('Username is required.');
          if (!pass) throw new Error('Password is required.');

          this.alf = new AlfApi(baseUrl);
          await this.alf.login(user, pass);
          vscode.window.showInformationMessage('ALF login successful.');

          // Also, store defaults so next session is prefilled even if user didn't click "Fetch" yet
          await saveDefaults(this.ctx, {
            baseUrl, username: user
          });
          if ((await getDefaults(this.ctx)).rememberPassword) {
            await this.ctx.secrets.store('alf.password', pass);
          }
          return;
        }

        /* ---------- Fetch result & analyze ---------- */
        if (msg?.type === 'alf-fetch-result') {
          if (!this.alf) throw new Error('Login first.');
          const searchId = String(msg.searchId || '');
          if (!searchId) throw new Error('Search ID is required.');

          const text = await this.alf.getResult(searchId);
          const analysis = analyzeAlfText(text);
          this.lastAnalysis = analysis;
          this.postAnalysis(analysis);

          // Persist last search id immediately
          await saveDefaults(this.ctx, { lastSearchId: searchId });
          return;
        }

        /* ---------- Explain with AI ---------- */
        if (msg?.type === 'explain-with-ai') {
          await this.explainWithAI();
          return;
        }

        /* ---------- Optional: analyze arbitrary text ---------- */
        if (msg?.type === 'analyze-text') {
          const analysis = analyzeAlfText(String(msg.text ?? ''));
          this.lastAnalysis = analysis;
          this.postAnalysis(analysis);
          return;
        }

      } catch (e: any) {
        this.error(e?.message || String(e));
      }
    });
  }

  /* =========================
     Webview send helpers
     ========================= */
  postAnalysis(analysis: Analysis) {
    this.view?.webview.postMessage({ type: 'analysis-done', payload: analysis });
  }

  private postAISummary(md: string) {
    this.view?.webview.postMessage({ type: 'ai-summary', markdown: md });
  }

  private error(message: string) {
    this.view?.webview.postMessage({ type: 'error', message });
  }

  /* =========================
     AI summarization
     ========================= */
  async explainWithAI() {
    if (!this.lastAnalysis) {
      this.error('Analyze logs first (Fetch Result).');
      return;
    }
    const token = new vscode.CancellationTokenSource().token;
    const md = await summarizeWithAI(this.lastAnalysis, token);
    this.postAISummary(md ?? renderHeuristicSummary(this.lastAnalysis));
  }
}

/* ============================================================
   AI helpers (Copilot via vscode.lm) + fallback
   ============================================================ */
async function summarizeWithAI(
  analysis: Analysis,
  token: vscode.CancellationToken
): Promise<string | null> {
  const lm = (vscode as any).lm;
  if (!lm || typeof lm.selectChatModels !== 'function') return null;

  const models = await lm.selectChatModels({ vendor: 'copilot' });
  const model = (models && models[0]) || null;
  if (!model) return null;

  const grouped = analysis.groups.slice(0, 8).map((g, i) => {
    const first = g.samples[0];
    return `#${i+1} x${g.count} | TopFrame: ${g.topFrame ?? 'n/a'} | Msg: ${(first?.msg || '').slice(0,200)}`;
  }).join('\n');

  const messages = [
    vscode.LanguageModelChatMessage.User(
`You are an ALF log incident analyst. Based on the grouped ALF errors below:
- Identify likely root cause(s)
- Point to suspect modules/files if stack frames indicate them
- Suggest immediate next steps (diagnostics & fix candidates)
- Be concise and structured

Grouped:
${grouped}`)
  ];

  const result = await model.sendRequest(messages, {}, token);
  let out = ''; for await (const part of result.text) out += part;
  return out || '(No content)';
}

function renderHeuristicSummary(a: Analysis): string {
  if (!a.groups.length) return 'No ERROR/FATAL groups found.';
  return a.groups.slice(0, 10).map((g, i) => {
    const msg = g.samples[0]?.msg || '';
    return `**#${i + 1} – ${g.count} hits**  
Top frame: \`${g.topFrame ?? 'n/a'}\`
\`\`\`
${msg}
\`\`\``;
  }).join('\n\n');
}
