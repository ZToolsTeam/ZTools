#!/usr/bin/env node
const http = require('http')
const fs = require('fs')
const path = require('path')
const WebSocket = require('ws')

const PORT = 9333
const CDP_PORT = 9222

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json'
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  // CDP HTTP 代理
  if (req.url.startsWith('/cdp/')) {
    const cdpPath = req.url.replace('/cdp', '')
    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port: CDP_PORT,
        path: cdpPath,
        method: req.method
      },
      (proxyRes) => {
        let body = ''
        proxyRes.on('data', (chunk) => (body += chunk))
        proxyRes.on('end', () => {
          // 替换 WebSocket URL 为代理地址
          const modified = body.replace(
            /ws:\/\/127\.0\.0\.1:9222/g,
            `ws://localhost:${PORT}/ws`
          )
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(modified)
        })
      }
    )
    proxyReq.on('error', () => {
      res.writeHead(502)
      res.end('Cannot connect to ZTools')
    })
    proxyReq.end()
    return
  }

  // 静态文件
  const filePath = path.join(
    __dirname,
    'web',
    req.url === '/' ? 'index.html' : req.url
  )
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404)
      res.end('Not Found')
    } else {
      res.writeHead(200, {
        'Content-Type': mimeTypes[path.extname(filePath)] || 'text/plain'
      })
      res.end(content)
    }
  })
})

// WebSocket 代理
const wss = new WebSocket.Server({ noServer: true })

server.on('upgrade', (request, socket, head) => {
  if (request.url.startsWith('/ws/')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
    })
  } else {
    socket.destroy()
  }
})

wss.on('connection', (clientWs, req) => {
  const targetPath = req.url.replace('/ws', '')
  const targetUrl = `ws://127.0.0.1:${CDP_PORT}${targetPath}`
  console.log('[WS] Connecting to:', targetUrl)

  const targetWs = new WebSocket(targetUrl)

  targetWs.on('open', () => console.log('[WS] Connected'))
  targetWs.on(
    'message',
    (data) => clientWs.readyState === 1 && clientWs.send(data)
  )
  targetWs.on('close', () => clientWs.close())
  targetWs.on('error', (e) => {
    console.log('[WS] Error:', e.message)
    clientWs.close()
  })

  clientWs.on(
    'message',
    (data) => targetWs.readyState === 1 && targetWs.send(data)
  )
  clientWs.on('close', () => targetWs.close())
})

server.listen(PORT, () => {
  console.log(`
  ZTools DevTools Web
  -------------------
  URL: http://localhost:${PORT}
  CDP Proxy: HTTP + WebSocket
  `)
  require('child_process').exec(`start http://localhost:${PORT}`)
})
