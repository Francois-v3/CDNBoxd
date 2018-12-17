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
const dns = require('dns');
const http = require('http');
const https = require('https');
const timers = require('timers');
const url = require('url');
const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');

const nodemailer = require('nodemailer');

var cdnboxStates = module.exports = { };

cdnboxStates.starttime = Date.now();

cdnboxStates.loadconfig = function (init) {

  // initializing data structs to set default values and avoid lot of tests.
  cdnboxStates.css = fs.readFileSync('cdnboxd.css','utf8');
  cdnboxStates.config = JSON.parse(fs.readFileSync('./config.json'));
  cdnboxStates.release = fs.readFileSync('./release','utf8').trim();
  if (init) { cdnboxStates.local = { "config": {} }; };
  var lconfig = cdnboxStates.config;
  if (lconfig.dnsserver.dnscountdownratio === undefined) { lconfig.dnsserver.dnscountdownratio = 1.2; }
  if (lconfig.dnsserver.dnscountavgmin === undefined) { lconfig.dnsserver.dnscountavgmin = 1.5; }
  if (lconfig.dnsserver.globalthrottlebwratio === undefined) { lconfig.dnsserver.globalthrottlebwratio = 0.4; }
  if (lconfig.dnsserver.globalthrottlelimit === undefined) { lconfig.dnsserver.globalthrottlelimit = 2; }
  cdnboxStates.globaldnscount = {
    "current": 0,
    "average": lconfig.dnsserver.dnscountavgmin * 15,
    "limit": -lconfig.dnsserver.dnscountavgmin
  };
  cdnboxStates.totaldnscount = {
    "current": 0,
    "average": 0
  };

  lconfig.cdnboxes.forEach(function(cdnbox) {
    var memo = {};
    if (!init) {
      memo.ipv4 = cdnboxStates[cdnbox.name].ipv4;
      memo.netint = cdnboxStates[cdnbox.name].netint;
      memo.nettime = cdnboxStates[cdnbox.name].nettime;
      memo.netcount = cdnboxStates[cdnbox.name].netcount;
    }
    cdnboxStates[cdnbox.name] = { "config": cdnbox,
        "bucket": cdnboxStates[cdnbox.name] !== undefined && cdnboxStates[cdnbox.name].bucket !== undefined?
                  cdnboxStates[cdnbox.name].bucket:0,
        "cache": {},
        "dnscount": cdnboxStates[cdnbox.name] === undefined || cdnboxStates[cdnbox.name].dnscount === undefined?
                    { "current": 0, "average": lconfig.dnsserver.dnscountavgmin }:
                    cdnboxStates[cdnbox.name].dnscount
    };
    if (!init) {
      cdnboxStates[cdnbox.name].ipv4 = memo.ipv4;
      cdnboxStates[cdnbox.name].netint = memo.netint;
      cdnboxStates[cdnbox.name].nettime = memo.nettime;
      cdnboxStates[cdnbox.name].netcount = memo.netcount;
    }
    if (cdnbox.proto === undefined) { cdnbox.proto = 'https:'; }
    if (cdnbox.isns === undefined) { cdnbox.isns = false; }
    if (cdnbox.ishttp === undefined) { cdnbox.ishttp = true; }
    if (cdnbox.fixscore !== undefined) { cdnboxStates[cdnbox.name].score = cdnbox.fixscore; }
    if (cdnbox.addscore === undefined) { cdnbox.addscore = 0; }
    if (cdnbox.isns && cdnbox.penal === undefined) { cdnbox.penal = 100; } 
    if (cdnbox.status === undefined) { cdnboxStates[cdnbox.name].status = "on"; }
    else { cdnboxStates[cdnbox.name].status = cdnbox.status }
    if (cdnbox.targetbw !== undefined) {
      if (cdnbox.floorbw === undefined) { cdnbox.floorbw = Math.floor(0.9 * cdnbox.targetbw); }
      if (cdnbox.ceilbw === undefined) { cdnbox.ceilbw = Math.ceil(1.1 * cdnbox.targetbw); }
    }
    if (cdnbox.dnsthrottlebwratio === undefined) { cdnbox.dnsthrottlebwratio = 0.4; }
    if (cdnbox.dnsthrottlehighratio === undefined) { cdnbox.dnsthrottlehighratio = 1.2; }
    if (cdnbox.dnsthrottlelowratio === undefined) { cdnbox.dnsthrottlelowratio = 2.0; }
    if (cdnbox.nspriorityratio === undefined) { cdnbox.nspriorityratio = 1; }
    if (cdnbox.localtests === undefined) { cdnbox.localtests = []; }
    cdnboxStates[cdnbox.name].localtests = {};
  });
  if (lconfig.states === undefined) { lconfig.states = { "penalgdown": 120 }; } 
  if (lconfig.clustersecret === undefined) { lconfig.clustersecret = lconfig.httpserver.authorization; }
}

cdnboxStates.loadconfig(true);

cdnboxStates.writeconfig = function (config) {
  fs.writeFileSync('./config.json', JSON.stringify(config, null, '  '));
}

// penal bucket
cdnboxStates.penalbucket = { "time": Date.now(), "count": 0, "sigma": 0 };

cdnboxStates.penalbucket.increase = function () {
  this.get();
  this.count += 0.1;
  this.calcsigma();
}

cdnboxStates.penalbucket.calcsigma = function () {
  var sigmabucket = 0;
  var lconfig = cdnboxStates.config;
  for (var i=0; i < lconfig.cdnboxes.length; i++ ) {
    if (cdnboxStates[lconfig.cdnboxes[i].name].bucket !== undefined) {
      sigmabucket += cdnboxStates[lconfig.cdnboxes[i].name].bucket;
    }
  }
  this.sigma = sigmabucket;
}

cdnboxStates.penalbucket.get = function () {
  var lconfig = cdnboxStates.config;
  var newtime = Date.now();
  this.count -= (newtime - this.time) / lconfig.states.penalgdown / 1000;
  this.time = newtime;
  if (this.count < 0) { this.count = 0; }
  cdnboxStates.local.bucket = this.count;
  calcScore(cdnboxStates.local);
  this.calcsigma();
  return Math.floor(this.count);
}


// get local IP addresses and network interfaces.
var address2iface = {}, ifconfig = os.networkInterfaces();
for (var iface in ifconfig) {
    ifconfig[iface].forEach(function(elem) {
      address2iface[elem.address] = iface;
    });
}

var cdnboxDNSserver;
cdnboxStates.init = async function (DNSserverclass, choose) {

  cdnboxDNSserver = DNSserverclass;
  var lconfig = cdnboxStates.config, ips;
  try {
    ips = await getwhoami();
  } catch (err) {
    logerror('"error": "Whoami failed !! ');
  }

  // initialisation cdnboxStates
  cdnboxStates.subscribestate = {};
  lconfig.cdnboxes.forEach(function(cdnbox) {
    var cdnboxState = cdnboxStates[cdnbox.name];
    if (!cdnboxState.config.cname) {
      dns.lookup(cdnboxState.config.hostname, { "all": true }, (err, addresses) => {
        if (addresses === undefined) {
          logerror('"error": "No DNS records for ' + cdnboxState.config.hostname + '"');
          setTimeout(function () { throw "No IP for hostname." }, 10000);
          return;
        }
        addresses.forEach( (address) => {
          if (address.family == 4) {
            cdnboxState.ipv4 = address.address;
            cdnboxState.ipv4n = address.address.split('.').reduce(
                function(ipInt, octet) { return (ipInt<<8) + parseInt(octet, 10)}, 0) >>> 0;
            // is it local node ?
            if (ips !== undefined && cdnboxState.ipv4 === ips.externalip) {
              cdnboxStates.local = cdnboxState; 
              cdnboxState.ipv4local = ips.localip;
            } else if (address2iface[cdnboxState.ipv4]) { 
              cdnboxStates.local = cdnboxState; 
              cdnboxState.ipv4local = cdnboxState.ipv4;
            }
            if (cdnbox.targetbw) {
              if (cdnboxState.ipv4 == cdnboxStates.local.ipv4) {
                if (address2iface[cdnboxState.ipv4local]) {
                  cdnboxState.netint = address2iface[cdnboxState.ipv4local];
                } else if (address2iface[cdnboxState.ipv4]) {
                  cdnboxState.netint = address2iface[cdnboxState.ipv4];
                }
                testCDNBoxes();
                getnetcount(cdnboxState);
                cdnboxState.bw = lconfig.dnsserver.dnsthrottlebwratio * cdnbox.targetbw + 1;
                cdnboxState.trendbw = cdnbox.targetbw;
                timers.setInterval( function () {
                    return function () { calcbw(cdnboxState); }}(), 2000);
              } else {
                subscriberemotebw(cdnbox);
                timers.setInterval( function () {
                    return function () { subscriberemotebw(cdnbox); }}(), 5000);
              }
            }
          } else if (address.family == 6) {
            cdnboxState.ipv6 = address.address;
            cdnboxState.ipv6tab = convertIPv6totab(address.address);
          } 
        });
        if (cdnbox.name == cdnboxStates.local.config.name && cdnboxState.config.isns) {
          cdnboxDNSserver.serve(choose, cdnboxState.config.dontbindall4?cdnboxState.ipv4local:'0.0.0.0');
          if (cdnboxState.ipv6) { cdnboxDNSserver.serveIPv6(cdnboxState.ipv6); }
        }
      });
    }
  });
  timers.setInterval(testCDNBoxes, 10000);
}


// calcul bandwith
function getnetcount(cdnboxState) {
  var data = fs.readFileSync('/proc/net/dev','utf8');
  data = data.replace(/\n/g,'');
  cdnboxState.netcount = 1*data.replace(
      new RegExp('^.*'+cdnboxState.netint+': +([0-9]+ +){8}([0-9]+) .*$'),"$2");
  cdnboxState.nettime = Date.now();
}

function calcbw(cdnboxState) {
  var memcount = cdnboxState.netcount, memtime = cdnboxState.nettime;
  getnetcount(cdnboxState);
  var delta = cdnboxState.netcount - memcount;
  if (delta < 0) { delta = 0 }
  cdnboxState.bw = delta * 8 / (cdnboxState.nettime - memtime) * 1000 / 1024 / 1024;
  cdnboxState.trendbw = (cdnboxState.bw + (14 * cdnboxState.trendbw)) / 15;
  if (cdnboxState.bw > 1.1 * cdnboxState.config.targetbw) { cdnboxStates.penalbucket.increase(); }
  var statevector = cdnboxStates.getstatevector();
  var cdnboxlist = Object.getOwnPropertyNames(cdnboxStates.subscribestate);
  for (var i = 0; i < cdnboxlist.length; i++) {
    cdnboxDNSserver.pushdata('pushbwdata', statevector, cdnboxStates[cdnboxlist[i]].ipv4);
  }
  console.log(' "type": "bw", "bw": ' + cdnboxState.bw + ', "trendbw": ' + cdnboxState.trendbw + ', ' +
              '"penal": ' + Math.floor(cdnboxStates.local.config.penal + cdnboxStates.penalbucket.sigma / 4) + ', ' +
              '"score": '+ cdnboxState.score + ', "vol": ' + delta);
}

cdnboxStates.getstatevector = function() {
    var cdnboxState = cdnboxStates.local;
    var time = Date.now();
    var hash = crypto.createHmac('sha256', cdnboxStates.config.clustersecret);
    hash.update(cdnboxState.config.name + (cdnboxState.bw !== undefined?cdnboxState.bw:-1) +
                (cdnboxState.trendbw !== undefined?cdnboxState.trendbw:-1) + time +
                cdnboxState.status + JSON.stringify(cdnboxState.localtests) +
                cdnboxStates.penalbucket.get());
    return '{"name":"' + cdnboxState.config.name + '", ' +
           '"bw":' + (cdnboxState.bw !== undefined?cdnboxState.bw:-1) + ', ' +
           '"trendbw":' + (cdnboxState.trendbw !== undefined?cdnboxState.trendbw:-1) + ', ' + 
           '"timestamp":' + time + ', ' +
           '"status":"' + cdnboxState.status + '", ' +
           '"localtests":' + JSON.stringify(cdnboxState.localtests) + ', ' +
           '"penalbucket":' + cdnboxStates.penalbucket.get() + ',' +
           '"hmac":"' + hash.digest('base64') + '"}';
}

cdnboxStates.putstatevectorhmac = function(statevector) {
  try {
    var data = JSON.parse(statevector);
    var hash = crypto.createHmac('sha256', cdnboxStates.config.clustersecret);
    hash.update(data.name + data.bw + data.trendbw + data.timestamp + data.status +
                JSON.stringify(data.localtests) + data.penalbucket);
    if (hash.digest('base64') == data.hmac) {
      cdnboxStates.putstatevectorobj(data);
    } else {
      logerror('"error": "putstatevectorhmac authentication failed from:' + data.name + '"');
    }
  } catch (e) {
    logerror('"error": "putstatevectorhmac ' + e.stack.replace(/\n/g,'').substr(0,200) + '"');
  }
}

cdnboxStates.putstatevector = function(statevector) {
  try {
    var data = JSON.parse(statevector);
    cdnboxStates.putstatevectorobj(data);
  } catch (e) {
    logerror('"error": "putstatevector ' + e.stack.replace(/\n/g,'').substr(0,200) + '"');
  }
}

cdnboxStates.putstatevectorobj = function(data) {
    var cdnboxState = cdnboxStates[data.name];
    if (cdnboxState === undefined) { return; }
    if (data.timestamp !== undefined) {
      if (cdnboxState.vectortimestamp !== undefined && cdnboxState.vectortimestamp > data.timestamp) {
        logerror('"error": "statevector too old on ' + data.name + '"');
        return;
      }
      cdnboxState.vectortimestamp = data.timestamp;
    }
    cdnboxState.bw = data.bw;
    cdnboxState.trendbw = data.trendbw;
    cdnboxState.status = data.status;
    if (cdnboxState.bucket != data.penalbucket) {
      cdnboxState.bucket = data.penalbucket;
      cdnboxStates.penalbucket.calcsigma();
    }
    cdnboxState.pushupdate = Date.now();
    cdnboxState.localtests = (data.localtests === undefined?{}:data.localtests);
}


cdnboxStates.subscribelocalbw = function(datastring) {
  try {
    var data = JSON.parse(datastring);
    var hash = crypto.createHmac('sha256', cdnboxStates.config.clustersecret);
    hash.update(data.name + data.time);
    if (hash.digest('base64') == data.hmac) {
      if (cdnboxStates[data.name] !== undefined) {
        cdnboxStates.subscribestate[data.name] = { "activated": true };
      } else {
        logerror('"error": "subscribelocalbw unknow node name:' + data.name + '"');
      }
    } else {
      logerror('"error": "subscribelocalbw authentication failed from:' + data.name + '"');
    }
  } catch (err) {
    console.error(err);
  }
}


function subscriberemotebw(cdnbox) {
  if (cdnboxStates.local.config.name === undefined) { return; }
  var cdnboxState = cdnboxStates[cdnbox.name];

  // don't get if push received for less than 5 seconds.
  if (cdnboxState.pushupdate !== undefined && Date.now() - cdnboxState.pushupdate < 5000) {
    return;
  }
  // dont subscribe if dontpushsubscribe is true.
  if (cdnboxState.config.dontpushsubscribe) { return; }
  // dont log error if just started (initial subscribe).
  if (Date.now() - cdnboxStates.starttime > 3000) {
    logerror('"error": "Push Timout. resubscribe to push state on: ' + cdnbox.name + '"');
  }
  // send udp subscribe
  var time = Date.now();
  var hash = crypto.createHmac('sha256', cdnboxState.clustersecret?cdnboxState.clustersecret:cdnboxStates.config.clustersecret);
  hash.update(cdnboxStates.local.config.name + time);
  cdnboxDNSserver.pushdata('subscribebwdata',
      '{"name":"' + cdnboxStates.local.config.name + '","time":' + time +
      ',"hmac":"' + hash.digest('base64') + '"}',
      cdnboxStates[cdnbox.name].ipv4);
}

function calcScore(cdnboxState) {
  if (cdnboxState.config.fixscore === undefined && cdnboxState.status === 'on') {
    cdnboxState.score = cdnboxState.gettime + cdnboxState.config.addscore + cdnboxState.bucket;
  }
}

// probes perf
var probeChild;
function getPerf(cdnbox) {
  if (cdnbox.fixscore !== undefined) { return; }
  var cdnboxState = cdnboxStates[cdnbox.name], cdnboxCache = cdnboxState.cache;

  // starts probechild process and process probe results.
  if (probeChild === undefined) {
    probeChild = childProcess.fork('lib/cdnboxProbe.js');
    probeChild.on('message', (msg) => {
        var cdnboxState = cdnboxStates[msg.name];
        cdnboxState.gettime = msg.perf;
        cdnboxState.cache.perflastupdate = Date.now();
        if (msg.status === 200) {
          // give local trafic a bonus.
          if (cdnboxState.config === cdnboxStates.local.config) { cdnboxState.gettime = Math.round(cdnboxState.gettime / 2); }
          calcScore(cdnboxState);
          if (cdnboxState.status === 'fail') { cdnboxState.status = 'on'; }
        } else {
          cdnboxState.score = 100000 + msg.status;
          if (cdnboxState.status === 'on') { cdnboxState.status = 'fail'; }
        }
    });
  }

  // starts probe or restart if unresponsive.
  if (cdnboxCache.perflastupdate === undefined || (Date.now() - cdnboxCache.perflastupdate > 20000)) {
    var perfoptions, myperfURL = cdnbox.perfURL;
    if (cdnbox.perfURL === undefined) { myperfURL = cdnbox.proto + '//' + cdnbox.hostname + '/cdn/image.gif'; } 
    var pu = url.parse(myperfURL);
    perfoptions = { protocol: pu.protocol, port: pu.port, path: pu.path, agent: false };
    if (cdnboxState.netint !== undefined) {
      perfoptions.hostname = '127.0.0.1';
      perfoptions.servername = pu.hostname
    } else {
      perfoptions.hostname = cdnbox.hostname;
    }
    perfoptions.headers = { 'Host': pu.hostname, 'Connection': 'close', 'User-Agent': 'CDNBoxBot 1.0' };
    if (cdnboxCache.perflastupdate !== undefined && (Date.now() - cdnboxCache.perflastupdate > 20000)) {
      cdnboxState.score = 100000;
      if (cdnboxState.status === 'on') { cdnboxState.status = 'fail'; }
      logerror('"error": "getPerf: timeout on ' + cdnbox.name + '"');
    }
    probeChild.send({ 'name': cdnbox.name, 'interval': 10000, 'options': perfoptions },
                    function (e) { if (e !== null) probeChild = undefined; });
  }
}

// whoami
function getwhoami() {
  return new Promise((resolve, reject) => {
    var options = { 'path': '/cdn/whoami', 'family': 4, agent: false };
    var lconfig = cdnboxStates.config, resolved = false;
    setTimeout(() => { reject(undefined); }, 5000);
    for (var i = 0; i < lconfig.cdnboxes.length; i++) {
      if (lconfig.cdnboxes[i].isns) {
        options.protocol = lconfig.cdnboxes[i].proto;
        options.hostname = lconfig.cdnboxes[i].hostname;
        var getter = (options.protocol == "http:"?http:https);
        getter.get(options, function () {
          return function (res) {
            if (!resolved && res.headers['x-ip']) {
              resolved = true;
              resolve({ 'localip': res.socket.localAddress, 'externalip': res.headers['x-ip'] });
              console.error("Whoami resolved by", res.socket.remoteAddress, 'to', res.headers['x-ip']);
            }
          }
        }())
        .on('error', (e) => {
          logerror('"error": "' + e.toString().replace(/"/g,'') + '"');
        });
      }
    }
  });
}

function testCDNBoxes() {
  cdnboxStates.penalbucket.get();
  cdnboxStates.config.cdnboxes.forEach(function(cdnbox) { getPerf(cdnbox); });
  // localtests
  if (cdnboxStates.local.config.localtests) dolocaltests(cdnboxStates.local);
  // get metrics
  if (cdnboxStates.local.config.varnishmetrics) getvarnishmetrics();
  console.log(' "type":"memory",' + JSON.stringify(process.memoryUsage()).replace(/[{}]/g, ''));
}

function dolocaltests(cdnboxState) {

  for (var i = 0; i < cdnboxState.config.localtests.length; i++) {
    var localtest = cdnboxState.config.localtests[i];
    var options = url.parse(localtest.url);
    var getter = (options.protocol == "http:"?http:https);
    var req = getter.request(options, function (cdnboxState, localtest) { return function (res) {
        res.on('data', (d) => {
          if (res.statusCode != 200) {
            logerror('"error": "localtest: ' + localtest.name + ' ' + res.statusCode + '"');
            cdnboxState.localtests[localtest.name] = false;
          } else {
            cdnboxState.localtests[localtest.name] = true;
          }
        });
    }}(cdnboxState, localtest))
    .setTimeout(3500);
    req.on('timeout', function (cdnboxState, req, localtest) {
      return function () {
        logerror('"error": "localtest: timeout on ' + cdnboxState.config.name + '"');
        cdnboxState.localtests[localtest.name] = false;
        req.abort();
      }
    }(cdnboxState, req, localtest))
    .on('error', function (cdnboxState, req, localtest) {
      return function (e) {
        logerror('"error": "localtest: ' + e.message + ' on ' + cdnboxState.config.name + '"');
        cdnboxState.localtests[localtest.name] = false;
        req.abort();
      }
    }(cdnboxState, req, localtest))
    .end();
  }
}

function getvarnishmetrics() {
  if (cdnboxStates.varnishmetrics === undefined) { cdnboxStates.varnishmetrics = {}; }
  var child = childProcess.execFile('varnishstat', ['-j', '-1'], (error, stdout, stderr) => {
    if (error) {
      console.error(error);
    } else {
      try {
        var vconf = cdnboxStates.config.varnishmetrics;
        var keys = Object.keys(vconf),
            vstat = JSON.parse(stdout),
            buff = ' "type":"varnish"';
        var currenttime = Date.now();
        var delta = (currenttime - (cdnboxStates.varnishmetrics.lasttime?cdnboxStates.varnishmetrics.lasttime:0)) / 1000;
        cdnboxStates.varnishmetrics.lasttime = currenttime;
        for (var i = 0; i < keys.length; i++) {
          switch (vstat[vconf[keys[i]]].flag) {
            case 'c':
              if (cdnboxStates.varnishmetrics[keys[i]] !== undefined) {
                buff += ',"' + keys[i] + '": ' +
                    Math.round((vstat[vconf[keys[i]]].value - cdnboxStates.varnishmetrics[keys[i]]) / delta); 
              }
              cdnboxStates.varnishmetrics[keys[i]] = vstat[vconf[keys[i]]].value;
              break;
            case 'g':
              buff += ',"' + keys[i] + '": ' + vstat[vconf[keys[i]]].value; 
          }
        }
        console.log(buff);
      } catch (err) {
        console.error(err);
      }
    }
  });
}

// initializing mailer
var mailtransporter = nodemailer.createTransport(
    { host: '127.0.0.1', port: 25, secure: false, ignoreTLS: true },
    { subject: "CDNBoxd message" }
);

// notification bucket
cdnboxStates.notificationbucket = { "time": Date.now(), "count": 0, "remindertime": 0 };

// Error logging and alerting.
var lastmessages = [];
function logerror(text) {
  console.log(' "type": "error", ' + text);
  var localconfig = cdnboxStates.local.config;
  if (localconfig.notification) {
    var bucket = cdnboxStates.notificationbucket, newtime = Date.now();
    bucket.count += 1;
    bucket.count -= (newtime - bucket.time) * localconfig.notification.threshold / localconfig.notification.period / 1000;
    bucket.time = newtime;
    if (bucket.count < 0) { bucket.count = 0; }
    lastmessages.unshift((new Date()).toString() + ': ' + text);
    if (lastmessages.length > localconfig.notification.lastmessagenumber) { lastmessages.pop(); }
    if (bucket.count > localconfig.notification.threshold && 
        newtime > bucket.remindertime + localconfig.notification.remindertime * 1000) {
      bucket.remindertime = newtime;
      bucket.count = 0;
      console.log(' "type": "notification", "data": "count: ' + bucket.count + '"');
      mailtransporter.sendMail(
         { to: localconfig.notification.email,
           from: "cdnboxd@" + cdnboxStates.local.config.hostname,
           subject: "CDNBoxd alert from " + cdnboxStates.local.config.hostname,
           text: "Last errors:\n" + lastmessages.join('\n')
         },
         (error, info) => {
           if (error) { return console.error(error); }
           console.log(' "type": "mail", "data": "Alert mail sent: ' + info.messageId + '" ');
         });
    }
  }
}
cdnboxStates.logerror = logerror;

function convertIPv6totab(address) {
  var tab = Buffer.alloc(16, 0);
  var index = 0, lastindex = 0, tabindex = 0;
  while (index < address.length) {
    if (address[index] == ':') {
      if (address[index + 1] == ':') { break; }
      tab.writeUInt16BE('0x' + address.slice(lastindex, index), tabindex);
      tabindex += 2;
      lastindex = index + 1;
    }
    index++;
  }
  tab.writeUInt16BE('0x' + address.slice(lastindex, index), tabindex);
  if (index < address.length) {
    var memoindex = index;
    tabindex = 14;
    index = lastindex = address.length
    while (index > memoindex) {
      if (address[index] == ':') {
        tab.writeUInt16BE('0x' + address.slice(index + 1, lastindex), tabindex);
        tabindex -= 2;
        lastindex = index;
      }
      index--;
    }
  }
  return tab;
}

