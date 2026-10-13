// scripts/browser-controller.mjs
// Lightweight Chrome DevTools Protocol (CDP) Controller for Automation
import http from 'node:http';

const CDP_PORT = 9223;

export async function getTabs() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  return await res.json();
}

export async function getActivePage() {
  const tabs = await getTabs();
  // Filter for real page targets
  return tabs.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
}

export async function executeCdp(method, params = {}) {
  const page = await getActivePage();
  if (!page) throw new Error('No active page found on port ' + CDP_PORT);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const id = Math.floor(Math.random() * 100000);

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('CDP Timeout'));
    }, 10000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ id, method, params }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id === id) {
          clearTimeout(timer);
          ws.close();
          if (msg.error) {
            reject(new Error(msg.error.message));
          } else {
            resolve(msg.result);
          }
        }
      } catch (err) {
        // ignore
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timer);
      reject(err);
    };
  });
}

export async function evaluateJs(expression) {
  const result = await executeCdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result?.result?.value;
}

export async function navigate(url) {
  return await executeCdp('Page.navigate', { url });
}

// CLI usage
const action = process.argv[2];
const arg1 = process.argv[3];

if (action === 'status') {
  const page = await getActivePage();
  if (!page) {
    console.log(JSON.stringify({ running: false }));
  } else {
    const title = await evaluateJs('document.title');
    const url = await evaluateJs('window.location.href');
    console.log(JSON.stringify({ running: true, title, url }));
  }
} else if (action === 'eval') {
  const res = await evaluateJs(arg1);
  console.log(JSON.stringify(res));
} else if (action === 'navigate') {
  await navigate(arg1);
  console.log('Navigated to', arg1);
}
