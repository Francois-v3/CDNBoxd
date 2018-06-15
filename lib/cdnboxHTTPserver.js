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
const maxmind = require('maxmind');

const countryLookup = maxmind.openSync('./GeoLite2-Country.mmdb');

const cdnboxStates = require('./cdnboxStates.js');

const image1x1 = new Buffer([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 
    0x80, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x2c, 
    0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 
    0x02, 0x44, 0x01, 0x00, 0x3b]);


// Lancement du server HTTP.
const httpserver = http.createServer((req, res) => {

  // acces libre
  if (req.url.startsWith("/cdn/image.gif")) {
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Timing-Allow-Origin': '*' });
    res.end(image1x1);
  } else if (req.url.startsWith("/cdn/perf.js")) {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=UTF-8',
        'Timing-Allow-Origin': '*', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
    perfjs(req,res);
    res.end();
  } else if (req.url.startsWith("/cdn/beacon")) {
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-cache' });
    perfbeacon(req,res);
    res.end(image1x1);
  } else if (req.url.startsWith("/cdn/states")) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    var cdnboxState = cdnboxStates.local;
    var subscribestate = req.headers['subscribe-state'];
    if (subscribestate && cdnboxStates[subscribestate] !== undefined) {
      cdnboxStates.subscribestate[subscribestate] = { "activated": true };
    }
    res.end(cdnboxStates.getstatevector(cdnboxStates.local));
  } else if (req.url.startsWith("/cdn/penalite")) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('' + (cdnboxStates.local.config.penal + Math.floor(cdnboxStates.penalbucket.sigma / 4)) + '\n');

  // acces limite.
  } else if (req.url.startsWith("/cdn/cdnboxStates") || req.url.startsWith("/cdn/config") ||
             req.url.startsWith("/cdn/cdnboxes") || req.url.startsWith("/cdn/console") ||
             req.url.startsWith("/cdn/api/states")) {

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
        if (req.url.match(/nocache/)) {
          function replacer(key, value) { if (key == 'cache') { return undefined; } return value; }
          res.end(JSON.stringify(cdnboxStates, replacer));
        } else {
          res.end(JSON.stringify(cdnboxStates));
        }
      } else if (req.url.startsWith("/cdn/api/states")) {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        apiStates(req,res);
        res.end();

      // UI (raw).
      } else if (req.url.startsWith("/cdn/cdnboxes")) {
        res.writeHead(200, { "Content-Type": "text/html", "Access-Control-Allow-Origin": "*" });
        htmlcdnboxes(req,res);
        res.end();
      } else if (req.url.startsWith("/cdn/console")) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        htmlconsole(res, buildtoken(req));
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
              res.end("{ 'message': 'cdnbox config updated.'");
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
                  res.end("{ 'message': 'cdnbox updated.'");
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
            res.end("{ 'message': 'unknowed cdnbox.'");
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
              res.end("{ 'message': 'unknowed cdnbox.'");
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
              res.end("{ 'message': 'unknowed cdnbox.'");
            }
          } else {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end("{ 'message': 'method not allowed.'");
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

function htmlcdnboxes(req,res) {

  if (req.url.includes("action=off")) {
    cdnboxStates.local.status = "off";
  }
  if (req.url.includes("action=on")) {
    cdnboxStates.local.status = "on";
  }
  res.write(
      '<html>\n<head>\n<meta charset="utf-8">\n' +
      '<title>' + cdnboxStates.local.config.name + ' CDNBoxes</title>\n' +
      '<style>' + cdnboxStates.css + '</style>\n' +
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
  res.write('</span>');
  var deltatime = (Date.now() - cdnboxStates.starttime) / 1000;
  res.write(
      '<span class="uptime">Up: ' + 
      Math.floor(deltatime / 3600 / 24) + 'j' + 
      Math.floor(deltatime / 3600 % 24) + 'h' + 
      Math.floor(deltatime / 60 % 60) + 'm' + 
      Math.floor(deltatime % 60) + 's </span></div>' +
      '<div class="head head2"><span class="release">' + cdnboxStates.release + '</span>' +
      '<span class="dnscount">DNS(r/m): ' + Math.round(cdnboxStates.totaldnscount.average) + '</span>' +
      '<span class="dnscount">DNSGT(r/s): ' + cdnboxStates.globaldnscount.last + '/' +
      Math.round(cdnboxStates.globaldnscount.average) + '/' +
      Math.round(cdnboxStates.globaldnscount.limit) + '</span></div>' +
      '<table><tr><th>Name</th><th>BW</th><th>BwT</th><th>Perf</th><th>Score</th>' +
      '<th>Bu.</th><th>HTTP</th><th>DNS</th><th>Tests</th></tr>'
  );
  for (var i=0; i < cdnboxStates.config.cdnboxes.length; i++ ) {
    var cdnboxState = cdnboxStates[cdnboxStates.config.cdnboxes[i].name];
    res.write(
        '<tr><td class="name">' + cdnboxStates.config.cdnboxes[i].name + '</td>' +
        '<td class="bw number' + (cdnboxState.bw > cdnboxState.config.targetbw?' ovbw':'') + '">' +
        (cdnboxState.bw?Math.round(cdnboxState.bw):'NA') + '</td>' +
        '<td class="bw number' + (cdnboxState.trendbw > cdnboxState.config.targetbw?' ovbw':'') + '">' +
        (cdnboxState.trendbw?Math.round(cdnboxState.trendbw):'NA') + '</td>' +
        '<td class="number">' + (cdnboxState.gettime !== undefined?cdnboxState.gettime:'NA') + '</td>' +
        '<td class="number">' + (cdnboxState.score !== undefined?Math.round(cdnboxState.score):'NA') + '</td>' +
        '<td class="number">' + Math.floor(cdnboxState.bucket) + '</td>' +
        '<td class="status">' +
        (cdnboxState.config.ishttp?(cdnboxState.status == 'on'?
            cdnboxState.dnscount.last:
            cdnboxState.status):'no') +
        '</td>' +
        '<td class="status">' + (cdnboxState.config.isns?'yes':'no') + '</td>');
    if (cdnboxState.localtests) {
      res.write( '<td class="status">');
      var testlist = Object.getOwnPropertyNames(cdnboxState.localtests);
      for (var j=0; j < testlist.length; j++) {
        if (cdnboxState.localtests[testlist[j]]) {
          res.write('<span class="bw">' + testlist[j][0] + '</span>');
        } else {
          res.write('<span class="bw ovbw">' + testlist[j][0] + '</span>');
        }
      }
      res.write( '</td>');
    } else {
      res.write('<td> </td>');
    }
    res.write( '</tr>');
  }
  res.write('</table>\n</body>\n</html>');
}

function htmlconsole(res,token) {

  res.write('<html>\n<header><meta charset="utf-8"><title>CDNBoxes Console</title>\n<script>\n');
  res.write(`
    function refreshframes() {
      var framelist = document.getElementsByTagName("iframe");
      var res = framelist[0].src.match(/token=([0-9]+)-[0-9A-Fa-f]+/);
      if (res === null || res.length < 2 || res[1] - 3000 < Date.now()) {
        return location.reload(true);
      } else {
        for (var i = 0; i < framelist.length; i++) {
          framelist[i].src = framelist[i].src.replace(/action=[a-zA-Z0-9]*/, "");
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
  \n`);
  res.write('</script>\n</header>\n<body onload="startautorefresh();">\n');
  res.write(`<div>
      <button type="button" onClick="refreshframes();">Refresh</button>
      <button type="button" id="stopaf" onClick="stopautorefresh();">Stop autorefresh</button>
      <button type="button" id="startaf" onClick="startautorefresh();">Start autorefresh</button>
      <span>Refresh (s): <input type="text" id="refreshtime" value="5" size="5"/></span>
  </div>\n`);
  for (var i=0; i < cdnboxStates.config.cdnboxes.length; i++ ) {
    var cdnboxState = cdnboxStates[cdnboxStates.config.cdnboxes[i].name];
    if (cdnboxState.config.isns) {
      res.write(
          '<iframe width="450" height="' + (cdnboxStates.config.cdnboxes.length * 25 + 90) + '" src="' +
          cdnboxState.config.proto + '//' + cdnboxState.config.hostname + '/cdn/cdnboxes?' +
          token + '"></iframe>\n'
      );
    }
  }
  res.write('\n</body>\n</html>');
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
          '"score": "' + cdnboxState.score + '", ' +
          '"penal": "' + Math.floor(cdnboxState.config.penal + cdnboxStates.penalbucket.sigma) + '", ' +
          '"bucket": "' + cdnboxState.bucket + '", ' +
          '"globalpenal": "' + Math.floor(cdnboxState.config.penal + cdnboxStates.penalbucket.sigma) + '", ' +
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
    var dt=0, ct=0, conc=0, sslt=0, sslc=0, totc=0, rdt=0, rct=0, dur=0,
        resources = performance.getEntriesByType("resource");
    for (var i = 0; i < resources.length; i++) {
      var j = resources[i];
      if (j.name.match(domain)) {; 
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
        ':C:' + Math.round(ct==0?0:ct/conc) + ':' + conc +
        ':L:' + Math.round(dur) +
        ':S:' + Math.round(sslt==0?0:sslt/sslc) + ':' + sslc +
        ':T:' + totc +
        ':N:' + btoa(navigator.userAgent);
    document.getElementsByTagName('body')[0].appendChild(s);
`;
var perfjscodecache = null;

function perfjs(req,res) {
  try {
    var clientip = getip(req);
    var country = countryLookup.get(clientip);
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
          log += ' "nav": "' + atob(stab[i]) + '",';
          break;
      }
    }
    var clientip = getip(req);
    var country = countryLookup.get(clientip);
    log += ' "country": "' + ((country && country.country)?country.country.iso_code:'none') + '",';
    log += ' "continent": "' + ((country && country.continent)?country.continent.code:'none') + '",';
    log += ' "client": "' + clientip + '"';
    console.log(log);
  } catch (e) {
    console.error(e);
  }
}

function atob(str) {
  return new Buffer(str, 'base64').toString('binary');
}

process.on('uncaughtException', (err) => {
  if (err.code == "ECONNRESET" && err.errno == "ECONNRESET" && err.syscall == "read") {
    console.log(' "type": "error", "error": "uncaughtException ECONNRESET"');
  } else {
    console.error('Process uncaught: ' + err);
    console.error(err.stack);
    process.exit(1);
  }
});

