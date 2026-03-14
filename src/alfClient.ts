import * as vscode from 'vscode';

export class AlfClient {
  constructor(
    private baseUrl: string,
    private username: string,
    private password: string
  ) {}

  private makeAuthHeader() {
    const token = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    return { Authorization: `Basic ${token}` };
  }

  private async request(path: string, method: 'GET' | 'POST', data?: any) {
    const url = new URL(path, this.baseUrl);

    let options: any = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...this.makeAuthHeader()
      }
    };

    if (method === 'GET' && data) {
      Object.keys(data).forEach(k => url.searchParams.append(k, data[k]));
    }

    if (method === 'POST' && data) {
      options.body = JSON.stringify(data);
    }

    const res = await fetch(url.toString(), options);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} – ${res.statusText}`);
    }

    return res.json();
  }

  // --- PORTS OF YOUR PYTHON FUNCTIONS ---

  login() {
    return this.request("auth/login", "POST", {
      username: this.username,
      password: this.password
    });
  }

  getTopology() {
    return this.request("topology/obe", "GET");
  }

  startSearch(data: any) {
    // Ensure startTime ends with Z
    if (data.startTime && !data.startTime.endsWith("Z")) {
      data.startTime += "Z";
    }
    return this.request("rest/search/start", "POST", data);
  }

  getSearchStatus(searchId: string) {
    return this.request("rest/info/status", "GET", { searchId });
  }

  getSearchResult(searchId: string) {
    return this.request("rest/search/result", "GET", { searchId, limit: 999999, offset: 0 });
  }
}