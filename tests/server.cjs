const http = require('http');
const fs = require('fs');
const path = require('path');
const root = process.cwd();
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8'};
http.createServer((req,res)=>{
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname); }
  catch(e) { res.writeHead(400); return res.end('Bad URL'); }
  if (pathname === '/') pathname = '/index.html';
  const file = path.resolve(root, '.' + pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file,(err,data)=>{
    if(err) { res.writeHead(err.code === 'ENOENT' ? 404 : 500); return res.end('Not found'); }
    res.writeHead(200,{'Content-Type':types[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-store'});
    res.end(data);
  });
}).listen(4173,'127.0.0.1',()=>console.log('Test server on http://127.0.0.1:4173'));
