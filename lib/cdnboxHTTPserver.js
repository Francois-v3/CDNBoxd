/*
  Copyright (c) 2018 Francois Veux.

  Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
  documentation files (the "Software"), to deal in the Software without restriction, including without limitation
  the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, 
  and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all copies or substantial portions 
  of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
  THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
  TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
*/

"use strict";
const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

var cdnboxStates = null;
const cdnboxMetrics = require('./cdnboxMetrics.js');

const image1x1 = Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 
    0x80, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x2c, 
    0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 
    0x02, 0x44, 0x01, 0x00, 0x3b]);

const css = fs.readFileSync('cdnboxd.css','utf8');

var cdnboxHTTPserver = module.exports = {};
cdnboxHTTPserver.init = function (cdnboxstates) {

cdnboxStates = cdnboxstates;

// Lancement du server HTTP.
const httpserver = http.createServer((req, res) => {

  // acces libre
  if (req.url.startsWith("/cdn/image.gif")) {
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Timing-Allow-Origin': '*', 'Connection': 'close' });
    res.end(image1x1);
  } else if (req.url.startsWith("/cdn/perf.js")) {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=UTF-8', 'Timing-Allow-Origin': '*',
        'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    perfjs(req,res);
    res.end();
  } else if (req.url.startsWith("/cdn/beacon")) {
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-cache' });
    perfbeacon(req,res);
    res.end(image1x1);
  } else if (req.url.startsWith("/cdn/penalite")) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('' + cdnboxStates.local.config.penal + '\n');
  } else if (req.url.startsWith("/cdn/whoami")) {
    var xip = req.headers['x-forwarded-for'];
    res.writeHead(204, { 'X-IP': xip?xip:res.socket.remoteAddress });
    res.end('');
  } else if (req.url.startsWith("/cdn/gettlsticketkeys")) {
    if (cdnboxStates.tlsticketkeys !== undefined) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8', 'Cache-Control': 'no-cache' });
      try {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-128-cbc', cdnboxStates.tlskey, iv);
        let encrypted = cipher.update(JSON.stringify(cdnboxStates.tlsticketkeys), 'utf8', 'hex');
        encrypted += cipher.final('hex');
        res.write(JSON.stringify( { "encrypted": encrypted, "iv": iv } ));
      } catch (err) {
        res.write(JSON.stringify(err));
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8', 'Cache-Control': 'no-cache' });
    }
    res.end('');
  // acces limite.
  } else if (req.url.startsWith("/cdn/cdnboxStates") || req.url.startsWith("/cdn/config") ||
             req.url.startsWith("/cdn/cdnboxes") || req.url.startsWith("/cdn/console") ||
             req.url.startsWith("/cdn/alias") || req.url.startsWith("/cdn/aliasmanager") ||
             req.url.startsWith("/cdn/api/states") || req.url.startsWith("/cdn/status")) {

    if (req.method === 'OPTIONS') {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Credentials": false,
        "Access-Control-Allow-Headers": "Authorization, X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept"
      });
      res.end();
    } else if (req.headers.authorization == cdnboxStates.config.httpserver.authorization ||
               verifytoken(req)) {
      if (req.url.startsWith("/cdn/cdnboxStates")) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(cdnboxStates,
		               (key, value) => { return key == 'countryLookup'?undefined:value; }));
      } else if (req.url.startsWith("/cdn/api/states")) {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        apiStates(req,res);
        res.end();
      } else if (req.url.startsWith("/cdn/status")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        cdnbox_status(req,res);

      // UI (raw).
      } else if (req.url.startsWith("/cdn/cdnboxes")) {
        res.writeHead(200, { "Content-Type": "text/html", "Access-Control-Allow-Origin": "*" });
        htmlcdnboxes(req, res);
        res.end();
      } else if (req.url.startsWith("/cdn/console")) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        htmlconsole(req, res);
        res.end();

      // config API.
      } else if (req.url.startsWith("/cdn/config")) {
        var configsrc = fs.readFileSync('./config.json');
        var config = JSON.parse(configsrc);
        if (req.url === "/cdn/config") {
          if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(configsrc);
          } else if (req.method === 'PUT') {
            var data = '';
            req.on('data', (d) => { data += d; } );
            req.on('end', () => {
              try {
                var remconfig = JSON.parse(data);
                cdnboxStates.writeconfig(remconfig);
              } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end('{ "message": "cdnbox config failed: ' + err + '"');
                return;
              }
              res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
              res.end('{ "message": "cdnbox config updated." }');
              throw("Config reload due to config PUT operation.");
            });
          } else {
            res.writeHead(405, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end('{ "message": "error method not allowed"}');
          }
        } else if (req.url.startsWith("/cdn/config/copyfrom/")) {
          var cdnboxname = req.url.substr(21);
          var index = 0;
          for (; index < config.cdnboxes.length && config.cdnboxes[index].name != cdnboxname; index++);
          if (index < config.cdnboxes.length) {
            var cdnboxconfig = cdnboxStates[cdnboxname].config;
            var options = {
              protocol: cdnboxconfig.proto,
              hostname: cdnboxconfig.hostname,
              path: '/cdn/config',
              headers: { "Content-Type": "application/json",
                         "Authorization": cdnboxStates.config.httpserver.authorization }
            };
            var lreq = (options.protocol == "http:"?http:https).request(options, (lres) => { 
              if (lres.statusCode != 200) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{ "message": "error code ' + lres.statusCode + ' from ' + cdnboxname + '"}');
              } else {
                var data = '';
                lres.on('data', (d) => { data += d; } );
                lres.on('end', () => {
                  try {
                    var remconfig = JSON.parse(data);
                    cdnboxStates.writeconfig(remconfig);
                  } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end('{ "message": "cdnbox copyfrom failed: ' + err + '"');
                    return;
                  }
                  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                  res.end('{ "message": "cdnbox updated." }');
                  throw("Config reload due to copyfrom operation.");
                });
              }
            })
            .setTimeout(5000);
            lreq.on('timeout', function (cdnboxconfig, req) {
              return function () { 
                logerror('"error": "/cdn/config/from/: timeout on ' + cdnboxconfig.name + '"');
                lreq.abort();
              }
            }(cdnboxconfig, req))
            .on('error', function (cdnboxconfig, req) {
              return function (e) {
                logerror('"error": "/cdn/config/from/: ' + e.message + ' on ' + cdnboxconfig.name + '"');
                lreq.abort();
              }
            }(cdnboxconfig, req))
            .end();
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{ "message": "unknowed cdnbox." }');
          }
        } else if (req.url.startsWith("/cdn/config/cdnbox/")) {
          var cdnboxname = req.url.substr(19);
          var index = 0;
          for (; index < config.cdnboxes.length && config.cdnboxes[index].name != cdnboxname; index++);
          if (req.method === "GET") {
            if (index < config.cdnboxes.length) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(config.cdnboxes[index]));
            } else {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end('{ "message": "unknowed cdnbox." }');
            }
          } else if  (req.method === "PUT") {
            req.on('data', (data) => {
              var cdnbox = '';
              try {
                cdnbox = JSON.parse(data);
                config.cdnboxes[index] = cdnbox;
                cdnboxStates.writeconfig(config);
                cdnboxStates.loadconfig(false);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(config.cdnboxes[index]));
              } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end('{ "message": "' + e + '" }');
              }
            });
          } else if  (req.method === "DELETE") {
            if (index < config.cdnboxes.length) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              config.cdnboxes.splice(index, 1);
              cdnboxStates.writeconfig(config);
              cdnboxStates.loadconfig(false);
              res.end('{ "message": "cdnbox deleted." }');
            } else {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end('{ "message": "unknowed cdnbox." }');
            }
          } else {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end("{ 'message': 'method not allowed.' }");
          }
        }

      // alias
      } else if (req.url.startsWith("/cdn/aliasmanager")) {
        res.writeHead(200, { "Content-Type": "text/html", "Access-Control-Allow-Origin": "*" });
        aliasmanager(res);
        res.end();
      } else if (req.url.startsWith("/cdn/alias")) {
        if (req.url === "/cdn/alias") {
          if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(fs.readFileSync('./aliases.json'));
          } else if (req.method === 'PUT') {
            var data = '';
            req.on('data', (d) => { data += d; } );
            req.on('end', () => {
              try {
                var remconfig = JSON.parse(data);
		if (remconfig.release !== cdnboxStates.alias.release) {
		  throw('Alias data has been modified. Update rejected.');
		}
		remconfig.release = cdnboxStates.alias.release + 1;
                cdnboxStates.writealias(remconfig);
              } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end('{ "message": "cdnbox alias failed: ' + err + '" }');
                return;
              }
              res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
              res.end('{ "message": "cdnbox aliases updated." }');
            });
          } else {
            res.writeHead(405, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end('{ "message": "error method not allowed"}');
          }
        }
      }
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json',
                           'WWW-Authenticate': 'Basic realm="Restricted area"'
      });
      res.end('{ "error": "authentication needed." }');
    }
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{ "error": "unknow endpoint" }');
  }
});

httpserver.listen(cdnboxStates.config.httpserver.port);
httpserver.on('listening', () => { 
  console.error("HTTP server launched on port %s", cdnboxStates.config.httpserver.port);
});
httpserver.on('error', (err) => {
  console.error("Could not launch HTTP server on port %s. Reason: %s", cdnboxStates.config.httpserver.port, err);
  process.exit(1);
});
httpserver.on('clientError', (err, socket) => {
  console.error("Client error: %s IP: %s", err, socket.remoteAddress);
  socket.destroy();
});

}

function htmlcdnboxes(req,res) {

  if (req.url.includes("action=off")) {
    cdnboxStates.local.status = "off";
    cdnboxStates.local.status6 = "off";
  }
  if (req.url.includes("action=on")) {
    cdnboxStates.local.status = "on";
    cdnboxStates.local.status6 = "on";
  }
  res.write(
      '<!DOCTYPE html><html lang="en">\n<head>\n<meta charset="utf-8">\n' +
      '<title>' + cdnboxStates.local.config.name + ' CDNBoxes</title>\n' +
      '<style>' + css + '</style>\n' +
      `<script>

         function rnum(num) {
           if (num > 10000000000) return Math.floor(num/1000000000) + 'G';
           if (num > 10000000) return Math.floor(num/1000000) + 'M';
           if (num > 10000) return Math.floor(num/1000) + 'K';
           return(num);
         }

         window.addEventListener("message", (event) => {
           if (event.data.cdnboxes !== undefined) {
	     if (event.data.cdnboxes) document.getElementById("tcdnbox").style.display = "table";
	     else document.getElementById("tcdnbox").style.display = "none";
	   }
           if (event.data.applis !== undefined) {
	     if (event.data.applis) document.getElementById("tapplis").style.display = "table";
	     else document.getElementById("tapplis").style.display = "none";
	   }
	 }, false);

	 window.addEventListener('DOMContentLoaded', (event) => {
  `);
  res.write('	   var applistats = ' + JSON.stringify(cdnboxStates.applistats));
  res.write(`
	   var memoapplistats = JSON.parse(sessionStorage.getItem('applistats'));
	   var tab = document.getElementById("tapplis");
	   var lignes = tab.getElementsByTagName("tr");
           for (var i = 0; i < lignes.length; i++) {
	     var cells = lignes[i].getElementsByTagName("td");
	     if (cells.length > 0) {
	       var cdnboxname = cells[0].innerHTML;
	       for (var j = 1; j < cells.length; j++) {
	         if (j === 1) {
  `);
  if (req.url.includes('applisdelta=true')) {
    res.write(`
                   cells[1].innerHTML = applistats[cdnboxname].count - memoapplistats[cdnboxname].count;
		 } else {
	           cells[j].innerHTML = 
		     applistats[cdnboxname][cells[j].getAttribute('data-cdnbox')].count -
		     memoapplistats[cdnboxname][cells[j].getAttribute('data-cdnbox')].count;
    `);
  } else {
    res.write(`
                   cells[1].innerHTML = rnum(applistats[cdnboxname].count);
		   } else {
	             cells[j].innerHTML = rnum(applistats[cdnboxname][cells[j].getAttribute('data-cdnbox')].count);
    `);
  }
  res.write(`
		 }
	       }
	     }
	   }
	   sessionStorage.setItem('applistats', JSON.stringify(applistats));

  `);

  res.write('      var aliasstats = ' + JSON.stringify(cdnboxStates.aliasstats));
  res.write(`
           var memoaliasstats = JSON.parse(sessionStorage.getItem('aliasstats'));
           var lignes = document.getElementById("talias").getElementsByTagName("tr");
           for (var i = 0; i < lignes.length; i++) {
             var cells = lignes[i].getElementsByTagName("td");
             if (cells.length > 0) {
               var aliasname = cells[0].innerHTML;
	       if (aliasstats[aliasname] !== undefined) {
  `);
  if (req.url.includes('applisdelta=true')) {
    res.write(' cells[2].innerHTML = aliasstats[aliasname].count - memoaliasstats[aliasname].count;');
  } else {
    res.write(' cells[2].innerHTML = rnum(aliasstats[aliasname].count);');
  }
  res.write(`
               }
             }
           }
           sessionStorage.setItem('aliasstats', JSON.stringify(aliasstats));

	 });
       </script>\n` +
      '</head>\n<body>\n' +
      '<div class="head ' +
          (cdnboxStates.local.config.ishttp?(cdnboxStates.local.status==='on'?'normal':'alert'):'') +
      '"><span class="name">' +
      cdnboxStates.local.config.name + '</span><span class="action">'
  );
  if (cdnboxStates.local.config.ishttp) {
    if (cdnboxStates.local.status != "off") {
      res.write('<a href="' + req.url + '&action=off">Off</a>');
    } else if (cdnboxStates.local.status == "off") {
      res.write('<a href="' + req.url + '&action=on">On</a>');
    }
  }
  res.write('</span>\n');
  var deltatime = (Date.now() - cdnboxStates.starttime) / 1000;
  res.write(
      '<span class="uptime">Up: ' + 
      Math.floor(deltatime / 3600 / 24) + 'j' + 
      Math.floor(deltatime / 3600 % 24) + 'h' + 
      Math.floor(deltatime / 60 % 60) + 'm' + 
      Math.floor(deltatime % 60) + 's </span>' +
      '<span class="memory">Rss: ' + Math.round(process.memoryUsage().rss/1024/1024) + 'Mio</span></div>' +
      '<div class="head head2"><span class="release">' + cdnboxStates.release + '/' +
      cdnboxStates.alias.release+ '</span>' +
      '<span class="dnscount">DNS(r/m): ' + Math.round(cdnboxStates.totaldnscount.average) + '</span>' +
      '<span class="dnscount">DNSGT(r/s): ' + cdnboxStates.globaldnscount.last + '/' +
      Math.round(cdnboxStates.globaldnscount.average) + '/' +
      Math.round(cdnboxStates.globaldnscount.limit) + '</span></div>' +
      '<table id="tcdnbox" style="display:' + (req.url.includes('cdnboxes=false')?'none':'table') + '">' +
      '<tr><th>Name</th><th>Trans</th><th>BwT</th><th>Recv</th><th>Perf4</th><th>Perf6</th><th>Score</th>' +
      '<th>HTTP</th><th>DNS</th><th>Tests</th></tr>'
  );
  for (var i=0; i < cdnboxStates.config.cdnboxes.length; i++ ) {
    var cdnboxState = cdnboxStates[cdnboxStates.config.cdnboxes[i].name];
    res.write(
        '<tr><td class="name">' + cdnboxStates.config.cdnboxes[i].name + '</td>' +
        '<td class="bw number' + (cdnboxState.bw > cdnboxState.config.targetbw?' ovbw':'') + '">' +
            (cdnboxState.bw?Math.round(cdnboxState.bw):'NA') + '</td>' +
        '<td class="bw number' + (cdnboxState.trendbw > cdnboxState.config.targetbw?' ovbw':'') + '">' +
            (cdnboxState.trendbw?Math.round(cdnboxState.trendbw):'NA') + '</td>' +
        '<td class="bw number">' + (cdnboxState.bwrecv?Math.round(cdnboxState.bwrecv):'NA') + '</td>' );
    if (cdnboxState.status == 'on') {
      res.write('<td class="number bw">' + (cdnboxState.gettime !== undefined?cdnboxState.gettime:'NA') + '</td>');
    } else {
      res.write('<td class="number bw ovbw">' + (cdnboxState.gettime !== undefined?cdnboxState.gettime:'NA') + '</td>');
    }
    if (!cdnboxStates.hasipv6 || cdnboxState.ipv6 === undefined) {
      res.write('<td class="number">NA</td>');
    } else {
      if (cdnboxState.status6 == 'on') {
        res.write('<td class="number bw">' + (cdnboxState.gettime6 !== undefined?cdnboxState.gettime6:'NA') + '</td>');
      } else {
        res.write('<td class="number bw ovbw">' + (cdnboxState.gettime6 !== undefined?cdnboxState.gettime6:'NA') + '</td>');
      } 
    }
    res.write(
        '<td class="number">' + (cdnboxState.score !== undefined?Math.round(cdnboxState.score):'NA') + '</td>' +
        '<td class="status">' +
        (cdnboxState.config.ishttp?(cdnboxState.status == 'on'?
            cdnboxState.dnscount.last:
            cdnboxState.status):'no') +
        '</td>' +
        '<td class="status">' + (cdnboxState.config.isns?'yes':'no') + '</td>');
    res.write( '<td class="status">');
    if (cdnboxState.localtests) {
      var testlist = Object.getOwnPropertyNames(cdnboxState.localtests);
      for (var j=0; j < testlist.length; j++) {
        if (cdnboxState.localtests[testlist[j]]) {
          res.write('<span class="bw">' + testlist[j][0] + '</span>');
        } else {
          res.write('<span class="bw ovbw">' + testlist[j][0] + '</span>');
        }
      }
    }
    res.write( '</td></tr>');
  }
  res.write('</table>');

  res.write('<table id="tapplis" class="applistats" style="display:' +
	    (req.url.includes('applis=true')?'table':'none') + '"><tr><th>Appli</th><th>Total</th>');
  for (const cdnbox of cdnboxStates.config.cdnboxes) {
    res.write('<th class="boxname">' + cdnbox.name + '</th>');
  }
  res.write('</tr>');
  for (const appli of Object.keys(cdnboxStates.config.applis)) {
    res.write(
        '<tr><td class="name">' + appli + '</td>' +
        '<td class="total number">-</td>');
    for (const cdnbox of cdnboxStates.config.cdnboxes) {
      res.write('<td class="number" data-cdnbox="' + cdnbox.name + '">-</td>');
    }
    res.write( '</tr>');
  }
  res.write('</table>');

  res.write('<table id="talias" class="aliasstats" style="display:' +
            (req.url.includes('alias=true')?'table':'none') + '"><tr><th>Alias</th><th>Target</th><th>Count</th></tr>');
  for (const alias of Object.keys(cdnboxStates.alias.aliases)) {
    res.write(
        '<tr><td class="name">' + alias + '</td>' +
        '<td class="name">' + cdnboxStates.alias.aliases[alias].target + '</td>' +
        '<td class="number">-</td></tr>');
  }
  res.write('</table>');

  res.write('</body>\n</html>');
}

function htmlconsole(req, res) {

  var token = buildtoken(req);
  res.write(`
    <!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>CDNBoxd Console</title>
    <style>` + css + `</style>
    <script>
    window.addEventListener('DOMContentLoaded', (event) => { refreshframes(); });
    function refreshframes() {
      var framelist = document.getElementsByName("cdnboxframe");
      var res = framelist[0].src.match(/token=([0-9]+)-[0-9A-Fa-f]+/);
      if (res === null || res.length < 2 || res[1] - 3000 < Date.now()) {
	window.location.assign('console' +
	  '?cdnboxes=' + document.getElementById('cdnbox').checked +
          '&applis=' + document.getElementById('applis').checked +
          '&alias=' + document.getElementById('alias').checked +
          '&applisdelta=' + document.getElementById('applisdelta').checked);
        return;
      } else {
        for (var i = 0; i < framelist.length; i++) {
          var url =  framelist[i].src.replace(/\\\?.*$/,"?") + '` + token + `';
          url += '&cdnboxes=' + document.getElementById('cdnbox').checked;
	  url += '&applis=' + document.getElementById('applis').checked;
	  url += '&alias=' + document.getElementById('alias').checked;
	  url += '&applisdelta=' + document.getElementById('applisdelta').checked;
	  framelist[i].src = url;
        }
      }
    }
    var refresher;
    function startautorefresh() {
      refresher = setInterval(refreshframes, document.getElementById("refreshtime").value * 1000);
      document.getElementById("startaf").disabled = true;
      document.getElementById("stopaf").disabled = false;
    }
    function stopautorefresh() {
      clearInterval(refresher);
      document.getElementById("stopaf").disabled = true;
      document.getElementById("startaf").disabled = false;
    }
    document.addEventListener("visibilitychange", function() {
      if (document.hidden && document.getElementById("startaf").disabled) { clearInterval(refresher); }
      if (!document.hidden && document.getElementById("startaf").disabled) {
        refresher = setInterval(refreshframes, document.getElementById("refreshtime").value * 1000);
      }
    });
    function setframeheight(obj) {
      var height = 70;
      if (document.getElementById('cdnbox').checked) {
        height += ` + (cdnboxStates.config.cdnboxes.length * 22 + 20) + `;
      }
      if (document.getElementById('applis').checked) {
        height += ` + (Object.keys(cdnboxStates.config.applis).length * 22 + 31) + `;
      }
      if (document.getElementById('alias').checked) {
        height += ` + (Object.keys(cdnboxStates.alias.aliases).length * 22 + 31) + `;
      }
      obj.height = height;
    }
    function changeframe() {
      var x = document.getElementsByName("cdnboxframe");
      for (var i = 0; i < x.length; i++) {
        setframeheight(x[i]);
	x[i].contentWindow.postMessage( 
	  { "cdnboxes": document.getElementById('cdnbox').checked,
	    "applis": document.getElementById('applis').checked },
	  x[i].src);
      } 
      refreshframes();
    }
    function aliasmanager() {
      document.getElementById("aliasmanager").src = '/cdn/aliasmanager';
      document.getElementById("aliasmanager").style.display = 'block';
      document.getElementById("overlay").style.display = 'block';
      window.addEventListener("message", (event) => {
        if (event.data.aliasmanagerclose) {
          document.getElementById("aliasmanager").style.display = 'none';
          document.getElementById("overlay").style.display = 'none';
        }
      }, false);
    }
  `);
  res.write('</script>\n</head>\n<body onload="startautorefresh();">\n');
  res.write(`
    <div>
      <button type="button" onClick="refreshframes();">Refresh</button>
      <span>Refresh (s): <input type="text" id="refreshtime" value="5" size="5"/></span>
      <button type="button" id="stopaf" onClick="stopautorefresh();">Stop</button>
      <button type="button" id="startaf" onClick="startautorefresh();">Start</button>
      <input type="checkbox" id="cdnbox" name="cdnbox"` +
        (req.url.includes('cdnboxes=true')?'checked':'') + ` onchange="changeframe();">
      <label for="cdnbox">Cdnboxes</label>
      <input type="checkbox" id="applis" name="applis"` +
        (req.url.includes('applis=true')?'checked':'') + ` onchange="changeframe();">
      <label for="applis">Applis</label>
      <input type="checkbox" id="alias" name="alias"` +
        (req.url.includes('alias=true')?'checked':'') + ` onchange="changeframe();">
      <label for="alias">Aliases</label>
      <input type="checkbox" id="applisdelta" name="applis"` +
        (req.url.includes('applisdelta=true')?'checked':'') + ` onchange="changeframe();">
      <label for="applisdelta">Derivate</label>
      <button type="button" id="startam" onClick="aliasmanager('block');">Alias Manager</button>
  </div>\n`);
  for (var i=0; i < cdnboxStates.config.cdnboxes.length; i++ ) {
    var cdnboxState = cdnboxStates[cdnboxStates.config.cdnboxes[i].name];
    if (cdnboxState.config.isns) {
      res.write(
          '<iframe width="540" name="cdnboxframe" src="' +
          cdnboxState.config.proto + '//' + cdnboxState.config.hostname + '/cdn/cdnboxes?' +
          token + '&cdnboxes=true" onload="setframeheight(this);"></iframe>\n'
      );
    }
  }
  res.write(`
    <div id="overlay"></div>
    <iframe id="aliasmanager" src=""></iframe>
  </body>
  </html>
  `);
}

function aliasmanager(res) {

  res.write(`
    <!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Alias Manager</title>
    <style>` + css + `</style>
    <script>
      function aliasadd() {
        var node = document.createElement("div");
	node.innerHTML = '<div class="aliascol"><input type="text" value=""></div> <div class="targetcol"><select>`);
	      for (var appli of Object.keys(cdnboxStates.config.applis)) {
                res.write('<option value="' + appli + '">' + appli + '</option>');
              }
  res.write(`</select></div><div class="deletecol"><input type="button" value="Delete" onclick="aliasdel(this);"></div>';
        document.getElementById('aliases').appendChild(node);
      }
      function aliasdel(node) {
        var aliasnode = node.parentElement.parentElement;
        aliasnode.parentElement.removeChild(aliasnode);
      }
      function updatealiases() {
        var jsondoc = '{';
	jsondoc += '"release": ' + document.getElementById('release').innerHTML + ',';
	jsondoc += '"ttl": ' + document.getElementById('ttl').value + ',';
	var aliases = document.getElementById('aliases').children;
	jsondoc += '"aliases": {';
	for (var i=1; i < aliases.length; i++) {
	  jsondoc += '"' + aliases[i].children[0].children[0].value + '": ' +
	             '{ "target": "' + aliases[i].children[1].children[0].value + '"}'; 
	  if (i < aliases.length - 1) jsondoc += ',';
	}
	jsondoc += '}}';

	const xhr = new XMLHttpRequest();
        xhr.onload = () => {
          alert(JSON.parse(xhr.responseText).message);
	  window.location = 'aliasmanager';
        };
        xhr.open('PUT', document.location.protocol + '//' + document.location.host + '/cdn/alias');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(jsondoc);

      }
      function aliasmanagerclose () {
	window.parent.postMessage({ "aliasmanagerclose": true }, window.parent.src);
      }
    </script>
    </head>
    <body>
      <div style="position:absolute; top:10px; right:10px;">
        <input type="button" value="&times;" style="font-size: 140%;" onclick="aliasmanagerclose();">
      </div>
      <h1>Alias manager</h1>
      <form>
      <div id="aliasmenu" style="position:relative;">
        <div style="position:absolute; top:1px; right:2px;">
	  <input type="button" id="update" value="Publish" onclick="updatealiases();">
	</div>
        <span>Release: </span><span id="release">` + cdnboxStates.alias.release + `</span>
        <label for="ttl">TTL:</label><input type="text" size="5" id="ttl" value="` + cdnboxStates.alias.ttl + `">
        <span id="reload"><input type="button" value="Reload" onclick="window.location = 'aliasmanager';"></span>
      </div>
      <br/>
      <div id="aliases">
      <div><div class="aliascol">Alias</div><div class="targetcol">Target</div><div class="countcol">Count</div></div>
  `);
  for (var alias of Object.keys(cdnboxStates.alias.aliases)) {
    res.write(`<div>
      <div class="aliascol"><input type="text" disabled=disabled id="` + alias + `" value="` + alias + `"></div>
      <div class="targetcol"><select>
    `);
    for (var appli of Object.keys(cdnboxStates.config.applis)) {
      res.write('<option value="' + appli + '"' +
	        (appli == cdnboxStates.alias.aliases[alias].target?' selected=selected':'') +
	        '>' + appli + '</option>');
    }
    res.write(`
      </select></div>
      <div class="countcol">` +
	(cdnboxStates.aliasstats[alias] !== undefined?rnum(cdnboxStates.aliasstats[alias].count):'0') +
      `</div>
      <div class="deletecol"><input type="button" value="Delete" onclick="aliasdel(this);"></div>
      </div>
    `);
  }
  res.write(`
      </div>
      <div id="addbutton"><input type="button" id="addalias" value="Add" onclick="aliasadd();"></div>
      </form>
    </body></html>
  `);
}

function rnum(num) {
  if (num > 10000000000) return Math.floor(num/1000000000) + 'G';
  if (num > 10000000) return Math.floor(num/1000000) + 'M';
  if (num > 10000) return Math.floor(num/1000) + 'K';
  return(num);
}

function buildtoken(req) {
    var time = Date.now() + 3600000;
    var hash = crypto.createHmac('sha256', cdnboxStates.config.clustersecret);
    hash.update(req.headers['user-agent'] + time);
    return 'token=' + time + '-' + hash.digest('hex');
}

function verifytoken(req) {
    var res = req.url.match(/token=([0-9]+)-[0-9A-Fa-f]+/);
    if (res === null || res.length < 2) { return false; }
    var time = Date.now();
    var tokentime = res[1];
    if (tokentime < time) { return false; }
    var hash = crypto.createHmac('sha256', cdnboxStates.config.clustersecret);
    hash.update(req.headers['user-agent'] + tokentime);
    return res[0] === 'token=' + tokentime + '-' + hash.digest('hex');
}

async function cdnbox_status(req,res) {
  var deltanetcount = 0, deltanetrecvcount = 0;
  if (cdnbox_status.memnetcount != undefined) {
    deltanetcount = cdnboxStates.local.netcount - cdnbox_status.memnetcount;
    if (cdnbox_status.memnetcount == 0 || deltanetcount < 0) deltanetcount = 0;
  }
  cdnbox_status.memnetcount = cdnboxStates.local.netcount;

  if (cdnbox_status.memnetrecvcount != undefined) {
    deltanetrecvcount = cdnboxStates.local.netrecvcount - cdnbox_status.memnetrecvcount;
    if (cdnbox_status.memnetrecvcount == 0 || deltanetrecvcount < 0) deltanetrecvcount = 0;
  }
  cdnbox_status.memnetrecvcount = cdnboxStates.local.netrecvcount;

  try {
    res.write( '{' +
      '"release": "' + cdnboxStates.release + '",' +
      '"uptime": ' + (Date.now() - cdnboxStates.starttime) / 1000 + ',' +
      '"dns_average_min": ' + cdnboxStates.totaldnscount.average + ',' +
      '"dns_average_sec": ' + cdnboxStates.local.dnscount.average + ',' +
      '"bw": ' + cdnboxStates.local.bw + ',' +
      '"trendbw": ' + cdnboxStates.local.trendbw + ',' +
      '"bwrecv": ' + cdnboxStates.local.bwrecv + ',' +
      '"inbound": ' + deltanetrecvcount + ',' +
      '"outbound": ' + deltanetcount + ',' +
      '"status": "' + cdnboxStates.local.status + '"' 
    );
    res.write( ', "mem": ' + JSON.stringify(process.memoryUsage()));
    if (cdnboxStates.eventloop.last.count > 0) {
      res.write( ', "evl": {' +
        '"count": ' + cdnboxStates.eventloop.last.count + ',' +
        '"moy": ' + Math.round(cdnboxStates.eventloop.last.cumul / cdnboxStates.eventloop.last.count) + ',' +
        '"max": ' + cdnboxStates.eventloop.last.max +
      '}');
    }
    if (cdnboxStates.local.config.varnishmetrics && cdnboxStates.config.varnishmetricsoutput === "status") {
      res.write(await cdnboxMetrics.getvarnishmetrics(cdnboxStates));
    }
    res.end('}');
  } catch (e) {
    console.error('http:' + e);
    res.end('');
  }
}

function apiStates(req,res) {

  try {
    res.write( '{' +
        '"name": "' + cdnboxStates.local.config.name + '",' +
        '"release": "' + cdnboxStates.release + '",' +
        '"uptime": ' + (Date.now() - cdnboxStates.starttime) / 1000 + ',' +
        '"totaldnscount": ' + cdnboxStates.totaldnscount.average + ',' +
        '"globaldnscount": { ' +
          '"last": ' + cdnboxStates.globaldnscount.last + ',' +
          '"avg": ' + cdnboxStates.globaldnscount.average + ',' +
          '"lim": ' + cdnboxStates.globaldnscount.limit +
        '},');
    res.write('"cdnboxes": [ ');
    for (var i=0; i < cdnboxStates.config.cdnboxes.length; i++ ) {
      var cdnboxState = cdnboxStates[cdnboxStates.config.cdnboxes[i].name];
      res.write('{ "name": "' + cdnboxStates.config.cdnboxes[i].name + '", ' +
          '"hostname": "' + cdnboxState.config.hostname + '", ' +
          '"proto": "' + cdnboxState.config.proto + '", ' +
          '"bw": "' + cdnboxState.bw + '", ' +
          '"trendbw": "' + cdnboxState.trendbw + '", ' +
          '"targetbw": "' + cdnboxState.config.targetbw + '", ' +
          '"perftime": "' + cdnboxState.gettime + '", ' +
          '"score": "' + cdnboxState.score + '", ' +
          '"status": "' + cdnboxState.status + '", ' +
          '"ishttp": ' + cdnboxState.config.ishttp + ', ' +
          '"localtests": ' + JSON.stringify(cdnboxState.localtests) + ', ' +
          '"isns": ' + cdnboxState.config.isns + ' ' +
      '}' + (i !== cdnboxStates.config.cdnboxes.length - 1?',':''));
    }
    res.write(' ],');
    res.write('"currenttime": ' + (Date.now() / 1000)); 
    res.write('}');
  } catch (e) {
    console.error(e);
  }
}

function getip(req) {
  if (req.headers['x-forwarded-for']) {
    var stab = req.headers['x-forwarded-for'].split(/[, ]+/);
    for (var i = stab.length - 1; i >= 0; i--) {
      if (stab[i] == '127.0.0.1' || stab[i] == '::1') continue;
      return stab[i];
    }
  }
  return req.socket.remoteAddress;
}

var perfjscount = 0;
var perfjscode = `
    var dt=0, ct=0, conc=0, sslt=0, sslc=0, totc=0, rdt=0, rct=0, dur=0, durt=0, durc=0,
        resources = performance.getEntriesByType("resource");
    for (var i = 0; i < resources.length; i++) {
      var j = resources[i];
      if (j.name.match(domain)) {
        totc++;
        if (j.domainLookupEnd - j.domainLookupStart > dt) {
          dt = j.domainLookupEnd - j.domainLookupStart;
        }
        if (j.connectEnd > j.connectStart) {
          ct += j.connectEnd - j.connectStart; conc++;
        }
        if (j.connectEnd > j.secureConnectionStart &&
            j.secureConnectionStart > j.connectStart) {
          sslt += j.connectEnd - j.secureConnectionStart; sslc++;
        }
        if (j.domainLookupStart !== 0 && j.duration > 0) {
          durt += j.duration; durc++;
        }
      }
      if (j.name.match(beaconurl)) {
        if (j.domainLookupEnd - j.domainLookupStart > rdt) {
          rdt = j.domainLookupEnd - j.domainLookupStart;
        }
        if (j.connectEnd - j.connectStart > rct) {
          rct = j.connectEnd - j.connectStart;
        }
        if (j.domainLookupStart !== 0 && j.duration > dur) { dur = j.duration; }
      }
    }
    var s = document.createElement('img');
    s.src = beaconurl + '/cdn/beacon?' +
        'D:' + Math.round(dt) + 
        ':A:' + Math.round(rdt) +
        ':B:' + Math.round(rct) +
        ':C:' + Math.round(conc===0?0:ct/conc) + ':' + conc +
        ':L:' + Math.round(dur) +
        ':M:' + Math.round(durc===0?0:durt/durc) + ':' + durc +
        ':S:' + Math.round(sslc===0?0:sslt/sslc) + ':' + sslc +
        ':T:' + totc +
        ':N:' + btoa(navigator.userAgent);
    document.getElementsByTagName('body')[0].appendChild(s);
`;
var perfjscodecache = null;

function perfjs(req,res) {
  if (cdnboxStates.countryLookup !== null) {
    try {
      var clientip = getip(req);
      var country = cdnboxStates.countryLookup.get(clientip);
      country = ((country && country.country)?country.country.iso_code:'none')
      perfjscount = ++perfjscount % 100;
      var weight = cdnboxStates.config.perf.weights[country] !== undefined?
                   cdnboxStates.config.perf.weights[country]:
                   cdnboxStates.config.perf.weights['default'];
      if (weight == 0 || perfjscount % Math.floor(100 / weight) != 0) {
        res.write('/* No Test */');
      } else {
        if (perfjscodecache === null && cdnboxStates.config && cdnboxStates.config.perf &&
            cdnboxStates.config.perf.domain && cdnboxStates.config.perf.beaconurl) {
          perfjscodecache = 'setTimeout( function() { var domain = /http(s)?:\\\/\\\/' + cdnboxStates.config.perf.domain +
              '/, beaconurl = \'' + cdnboxStates.config.perf.beaconurl + '\';' +
              perfjscode.replace(/\s+/g, ' ').replace(/; /g, ';').replace(/, /g, ',').replace(/ \+ /g, '+').replace(/ = /g, '=') +
              '}, ' + (cdnboxStates.config.perf.delay?cdnboxStates.config.perf.delay:2000) + ');';
        }
        res.write(perfjscodecache!== null?perfjscodecache:'/* No Test */');
      }
    } catch (e) {
      console.error(e);
    }
  } else {
    res.write('/* No Geolocation */');
  }
}

function perfbeacon(req,res) {
  try {
    var stab = req.url.substr(12).split(':');
    var log = '"type": "perf",';
    for (var i = 0; i < stab.length; i++) {
      switch (stab[i]) {
        case 'A':
          i++;
          log += ' "rdnst": ' + stab[i] + ',';
          break;
        case 'B':
          i++;
          log += ' "rcont": ' + stab[i] + ',';
          break;
        case 'D':
          i++;
          log += ' "dnst": ' + stab[i] + ',';
          break;
        case 'L':
          i++;
          log += ' "rdur": ' + stab[i] + ',';
          break;
        case 'M':
          i++;
          log += ' "durt": ' + stab[i] + ',';
          i++;
          log += ' "durc": ' + stab[i] + ',';
          break;
        case 'C':
          i++;
          log += ' "cont": ' + stab[i] + ',';
          i++;
          log += ' "conc": ' + stab[i] + ',';
          break;
        case 'S':
          i++;
          log += ' "sslt": ' + stab[i] + ',';
          i++;
          log += ' "sslc": ' + stab[i] + ',';
          break;
        case 'T':
          i++;
          log += ' "tot": ' + stab[i] + ',';
          break;
        case 'N':
          i++;
          log += ' "nav": ' + JSON.stringify(atob(stab[i])) + ',';
          break;
      }
    }
    var clientip = getip(req);
    var country = cdnboxStates.countryLookup.get(clientip);
    log += ' "country": "' + ((country && country.country)?country.country.iso_code:'none') + '",';
    log += ' "continent": "' + ((country && country.continent)?country.continent.code:'none') + '",';
    log += ' "client": "' + clientip + '"';
    cdnboxStates.logconsole(log);
  } catch (e) {
    console.error(e);
  }
}

function atob(str) {
  return Buffer.from(str, 'base64').toString('binary');
}

process.on('uncaughtException', (err) => {
  if (err.code == "ECONNRESET" && (err.errno == "ECONNRESET" || err.errno == -104) && err.syscall == "read") {
    cdnboxStates.logconsole('"type": "error", "error": "uncaughtException ECONNRESET during read ' + err.errno + '"');
  } else if (err.code == "ECONNRESET" && err.errno == -104 && err.syscall == "write") {
    cdnboxStates.logconsole('"type": "error", "error": "uncaughtException ECONNRESET during write ' + err.stack.replace(/\n/g,'').substr(0,200) + '"');
  } else if (err.code == "ETIMEDOUT" && err.errno == -110 && err.syscall == "read") {
    cdnboxStates.logconsole('"type": "error", "error": "uncaughtException ETIMEDOUT ' + err.stack.replace(/\n/g,'').substr(0,200) + '"');
  } else {
    console.error('Process uncaught: ' + err);
    console.error('Process uncaught details: %s %s %s', err.code, err.errno, err.syscall);
    console.error(err.stack);
    process.exit(1);
  }
});

