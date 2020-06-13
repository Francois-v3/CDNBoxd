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

cdnboxStates.loadconfig = function () {

  // initializing data structs to set default values and avoid lot of tests.
  cdnboxStates.css = fs.readFileSync('cdnboxd.css','utf8');
  cdnboxStates.config = JSON.parse(fs.readFileSync('./config.json'));
  cdnboxStates.release = fs.readFileSync('./release','utf8').trim();
  cdnboxStates.local = { "config": {} };
  var lconfig = cdnboxStates.config;

  // get local IP addresses and network interfaces.
  var ifconfig = os.networkInterfaces();
  cdnboxStates.address2iface = {};
  for (var iface in ifconfig) {
    ifconfig[iface].forEach(function(elem) {
      cdnboxStates.address2iface[elem.address] = iface;
      if (!elem.internal && elem.family == "IPv6" && elem.scopeid == 0) {
        cdnboxStates.hasipv6 = elem.address;
      }
    });
  }

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
    cdnboxStates[cdnbox.name] = { "config": cdnbox,
        "bucket": cdnboxStates[cdnbox.name] !== undefined && cdnboxStates[cdnbox.name].bucket !== undefined?
                  cdnboxStates[cdnbox.name].bucket:0,
        "dnscount": cdnboxStates[cdnbox.name] === undefined || cdnboxStates[cdnbox.name].dnscount === undefined?
                    { "current": 0, "average": lconfig.dnsserver.dnscountavgmin }:
                    cdnboxStates[cdnbox.name].dnscount
    };
    if (cdnbox.proto === undefined) { cdnbox.proto = 'https:'; }
    if (cdnbox.isns === undefined) { cdnbox.isns = false; }
    if (cdnbox.ishttp === undefined) { cdnbox.ishttp = true; }
    if (cdnbox.dontbindall4 === undefined) { cdnbox.dontbindall4 = true; }
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

cdnboxStates.loadconfig();

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

var cdnboxDNSserver;
cdnboxStates.init = async function (DNSserverclass, choose) {

  cdnboxDNSserver = DNSserverclass;
  var lconfig = cdnboxStates.config, ips;
  try {
    ips = await getwhoami();
    if (ips === undefined) { logerror('"error": "Whoami undefined !! '); }
  } catch (err) {
    logerror('"error": "Whoami failed !! ' + err);
  }
  if (lconfig.tlsticketkeys !==  undefined) {
    if (lconfig.tlsticketkeys.ttl ===  undefined) { lconfig.tlsticketkeys.ttl = 86400000; }
    if (lconfig.tlsticketkeys.refresh ===  undefined) { lconfig.tlsticketkeys.refresh = 3600000; }
    inittlsticketkeys(ips);
    updatetlsticketkeys();
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
            // is it local node ?
	    if (ips !== undefined &&
		(address.address === ips.externalip || address.address.startsWith("127."))) {
              cdnboxStates.local = cdnboxState; 
              cdnboxState.ipv4 = ips.externalip;
              cdnboxState.ipv4local = ips.localip;
	    } else if (cdnboxStates.address2iface[address.address]) {
              cdnboxStates.local = cdnboxState; 
              cdnboxState.ipv4 = address.address;
              cdnboxState.ipv4local = cdnboxState.ipv4;
	    } else {
              cdnboxState.ipv4 = address.address;
	    }
            cdnboxState.ipv4n = cdnboxState.ipv4.split('.').reduce(
                function(ipInt, octet) { return (ipInt<<8) + parseInt(octet, 10)}, 0) >>> 0;
            if (cdnbox.targetbw) {
              if (cdnboxState.ipv4 == cdnboxStates.local.ipv4) {
                if (cdnboxStates.address2iface[cdnboxState.ipv4local]) {
                  cdnboxState.netint = cdnboxStates.address2iface[cdnboxState.ipv4local];
                } else if (cdnboxStates.address2iface[cdnboxState.ipv4]) {
                  cdnboxState.netint = cdnboxStates.address2iface[cdnboxState.ipv4];
                }
                testCDNBoxes();
                getnetcount(cdnboxState);
                cdnboxState.bw = lconfig.dnsserver.dnsthrottlebwratio * cdnbox.targetbw + 1;
                cdnboxState.trendbw = cdnbox.targetbw;
                cdnboxState.bwrecv = 0;
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
	    cdnboxState.status6 = 'fail';
          } 
        });
        if (cdnbox.name == cdnboxStates.local.config.name && cdnboxState.config.isns) {
          cdnboxDNSserver.serve(choose, cdnboxState.config.dontbindall4?cdnboxState.ipv4local:'0.0.0.0');

	  // fix 127.0.1.1 in /etc/hosts problem: check if host ipv6 dos not reverse to host name.
          if (!cdnboxState.ipv6 && cdnboxStates.hasipv6) {
            dns.reverse(cdnboxStates.hasipv6, (err, addresses) => {
              if (cdnboxState.config.hostname == addresses[0]) {
                console.error("Fixing 127.0.1.1 problem with reverse IP matching " + cdnboxState.config.hostname);
                cdnboxState.ipv6 = cdnboxStates.hasipv6;
                cdnboxState.ipv6tab = convertIPv6totab(cdnboxStates.hasipv6);
                cdnboxState.status6 = 'fail';
                cdnboxDNSserver.serveIPv6(cdnboxState.ipv6);
              }
            });
          } else if (cdnboxState.ipv6) {
            cdnboxDNSserver.serveIPv6(cdnboxState.ipv6);
	  }
        }
      });
    }
  });
  timers.setInterval(testCDNBoxes, 10000);
}


// calcul bandwith
function getnetcount(cdnboxState) {
  const netoutre = new RegExp('^.*'+cdnboxState.netint+': +([0-9]+ +){8}([0-9]+) .*$');
  const netrecvre = new RegExp('^.*'+cdnboxState.netint+': +([0-9]+) +([0-9]+ +){8}.*$');
  let data = fs.readFileSync('/proc/net/dev','utf8');
  data = data.replace(/\n/g,'');
  cdnboxState.netcount = 1*data.replace(netoutre, "$2");
  cdnboxState.nettime = Date.now();
  cdnboxState.netrecvcount = 1*data.replace(netrecvre, "$1");
}

function calcbw(cdnboxState) {
  let memcount = cdnboxState.netcount, memrecvcount = cdnboxState.netrecvcount, memtime = cdnboxState.nettime;
  getnetcount(cdnboxState);
  let delta = cdnboxState.netcount - memcount;
  if (delta < 0) { delta = 0 }
  cdnboxState.bw = delta * 8 / (cdnboxState.nettime - memtime) * 1000 / 1024 / 1024;
  cdnboxState.trendbw = (cdnboxState.bw + (14 * cdnboxState.trendbw)) / 15;
  let deltarecv = cdnboxState.netrecvcount - memrecvcount;
  if (deltarecv < 0) { deltarecv = 0 }
  cdnboxState.bwrecv = deltarecv * 8 / (cdnboxState.nettime - memtime) * 1000 / 1024 / 1024;
  if (cdnboxState.bw > 1.1 * cdnboxState.config.targetbw) { cdnboxStates.penalbucket.increase(); }
  var statevector = cdnboxStates.getstatevector();
  var cdnboxlist = Object.getOwnPropertyNames(cdnboxStates.subscribestate);
  for (var i = 0; i < cdnboxlist.length; i++) {
    cdnboxDNSserver.pushdata('pushbwdata', statevector, cdnboxStates[cdnboxlist[i]].ipv4);
  }
  console.log(' "type": "bw", "bw": ' + cdnboxState.bw + ', "trendbw": ' + cdnboxState.trendbw + ' ,' +
	      '"bwrecv": ' + cdnboxState.bwrecv + ' ,' + 
              '"penal": ' + Math.floor(cdnboxStates.local.config.penal + cdnboxStates.penalbucket.sigma / 4) + ', ' +
              '"score": '+ (isNaN(cdnboxState.score)?-1:cdnboxState.score) + ', "vol": ' + delta);
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
           '"bwrecv":' + (cdnboxState.bwrecv !== undefined?cdnboxState.bwrecv:-1) + ', ' +
           '"trendbw":' + (cdnboxState.trendbw !== undefined?cdnboxState.trendbw:-1) + ', ' + 
           '"timestamp":' + time + ', ' +
           '"status":"' + cdnboxState.status + '", ' +
           '"status6":"' + cdnboxState.status6 + '", ' +
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
      putstatevectorobj(data);
    } else {
      logerror('"error": "putstatevectorhmac authentication failed from:' + data.name + '"');
    }
  } catch (e) {
    logerror('"error": "putstatevectorhmac ' + e.stack.replace(/\n/g,'').substr(0,200) + '"');
  }
}

function putstatevectorobj (data) {
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
    if (data.bwrecv !== undefined) { cdnboxState.bwrecv = data.bwrecv; }
    if (data.status == 'off' || cdnboxState.status !== 'fail') { cdnboxState.status = data.status; }
    if (data.status6 !== undefined && (data.status6 == 'off' || cdnboxState.status6 !== 'fail')) {
      cdnboxState.status6 = data.status6;
    }
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
  var cdnboxState = cdnboxStates[cdnbox.name];
  if (cdnboxState.perflastupdate === undefined) { cdnboxState.perflastupdate = 0; }
  if (cdnboxState.perflastupdate6 === undefined) { cdnboxState.perflastupdate6 = 0; }

  // starts probechild process and process probe results.
  if (probeChild === undefined) {
    probeChild = childProcess.fork('lib/cdnboxProbe.js');
    probeChild.on('message', (msg) => {
        if (msg.type == "perf") {
          var cdnboxState = cdnboxStates[msg.name];
	  if (msg.ipv == 4) {
	    cdnboxState.perflastupdate = Date.now();
            cdnboxState.gettime = msg.perf;
	  } else { 
	    cdnboxState.perflastupdate6 = Date.now(); 
            cdnboxState.gettime6 = msg.perf;
	  }
	  // detection de changement d'IP.
	  if (cdnboxState !== cdnboxStates.local && !cdnboxState.config.cname) {
	    if (msg.ipv === 4 && msg.ip !== cdnboxState.ipv4) { 
	      if (msg.ip === undefined || msg.ip == "undefined") {
		delete cdnboxState.ipv4;
		delete cdnboxState.ipv4n;
	      } else {
                cdnboxState.ipv4 = msg.ip;
                cdnboxState.ipv4n = cdnboxState.ipv4.split('.').reduce(
                  function(ipInt, octet) { return (ipInt<<8) + parseInt(octet, 10)}, 0) >>> 0;
	      }
              logerror('"error": "IPv4 for ' + cdnboxState.config.hostname + ' has changed. Updated."');
	    }
	    if (msg.ipv === 6 && msg.ip !== cdnboxState.ipv6) {
	      if (msg.ip === undefined || msg.ip == "undefined") {
		delete cdnboxState.ipv6;
		delete cdnboxState.ipv6tab;
	      } else {
                cdnboxState.ipv6 = msg.ip;
                cdnboxState.ipv6tab = convertIPv6totab(cdnboxState.ipv6);
	      }
              logerror('"error": "IPv6 for ' + cdnboxState.config.hostname + ' has changed. Updated."');
	    }
	  }

	  if (msg.status === 200) {
            // give local trafic a bonus.
	    if (msg.ipv == 4) { 
              if (cdnboxState.config === cdnboxStates.local.config) { cdnboxState.gettime = Math.round(cdnboxState.gettime / 2); }
              calcScore(cdnboxState);
	      if (cdnboxState.status === 'fail') { cdnboxState.status = 'on'; }
	    } else {
	      if (cdnboxState.status6 === 'fail') { cdnboxState.status6 = 'on'; }
	    }
          } else {
	    if (msg.ipv == 4) { 
              cdnboxState.score = 100000 + msg.status;
              if (cdnboxState.status === 'on') { cdnboxState.status = 'fail'; }
	    } else {
              if (cdnboxState.status6 === 'on') { cdnboxState.status6 = 'fail'; }
	    }
          }
        } else if (msg.type == "log") {
          console.log(msg.msg);
        } else if (msg.type == "err") {
          logerror('"error": "' + msg.error + '"');
        }
    });
  }

  // starts probe or restart if unresponsive.
  if ((Date.now() - cdnboxState.perflastupdate > 20000) ||
      (cdnboxState.ipv6 !== undefined && Date.now() - cdnboxState.perflastupdate6 > 20000)) {
    var perfoptions, myperfURL = cdnbox.perfURL;
    if (cdnbox.perfURL === undefined) { myperfURL = cdnbox.proto + '//' + cdnbox.hostname + '/cdn/image.gif'; } 
    var pu = url.parse(myperfURL);
    perfoptions = { protocol: pu.protocol, port: pu.port, path: pu.path, agent: false };
    perfoptions.headers = { 'Host': pu.hostname, 'Connection': 'close', 'User-Agent': 'CDNBoxBot 1.0' };
    perfoptions.hostname = cdnbox.hostname;
    perfoptions.servername = pu.hostname
    if (Date.now() - cdnboxState.perflastupdate > 20000) {
      cdnboxState.score = 100000;
      if (cdnboxState.status === 'on') { cdnboxState.status = 'fail'; }
      if (cdnboxState.perflastupdate !== 0) { logerror('"error": "getPerf: IPv4 timeout on ' + cdnbox.name + '"'); }
      perfoptions.family = 4;
      if (cdnboxState.netint !== undefined) { perfoptions.hostname = '127.0.0.1'; }
      probeChild.send({ 'name': cdnbox.name, 'interval': 10000, 'options': perfoptions },
                      function (e) { if (e !== null) probeChild = undefined; });
    }
    if (cdnboxState.ipv6 !== undefined && Date.now() - cdnboxState.perflastupdate6 > 20000) {
      if (cdnboxState.status6 === 'on') { cdnboxState.status6 = 'fail'; }
      if (cdnboxState.perflastupdate6 !== 0) { logerror('"error": "getPerf: IPv6 timeout on ' + cdnbox.name + '"'); }
      perfoptions.family = 6;
      if (cdnboxState.netint !== undefined) { perfoptions.hostname = '::1'; }
      probeChild.send({ 'name': cdnbox.name, 'interval': 10000, 'options': perfoptions },
                      function (e) { if (e !== null) probeChild = undefined; });
    }
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
            if (!resolved && res.headers['x-ip'] && !res.socket.localAddress.startsWith("127.")) {
              resolved = true;
              resolve({ 'localip': res.socket.localAddress, 'externalip': res.headers['x-ip'] });
              console.error("Whoami resolved by", res.socket.remoteAddress, 'to', res.headers['x-ip']);
            }
          }
        }())
        .on('error', (e) => {
          console.error('"error": "' + e.toString().replace(/"/g,'') + '"');
          logerror('"error": "' + e.toString().replace(/"/g,'') + '"');
        });
      }
    }
  });
}

// inittlsticketkeys
function inittlsticketkeys(ips) {
    // if no one answer within 35 seconds, builds new keys
    setTimeout(() => {
        var lconfig = cdnboxStates.config;
        if (cdnboxStates.tlsticketkeys === undefined) {
          var tlsdateref = Math.floor(Date.now() / lconfig.tlsticketkeys.ttl) * lconfig.tlsticketkeys.ttl;
          cdnboxStates.tlsticketkeys = [];
          cdnboxStates.tlsticketkeys[0] = { "key": crypto.randomBytes(48).toString('base64'), "timestamp": tlsdateref - 2 * lconfig.tlsticketkeys.ttl };
          cdnboxStates.tlsticketkeys[1] = { "key": crypto.randomBytes(48).toString('base64'), "timestamp": tlsdateref - lconfig.tlsticketkeys.ttl };
          cdnboxStates.tlsticketkeys[2] = { "key": crypto.randomBytes(48).toString('base64'), "timestamp": tlsdateref };
          writetlsticketkeys();
          console.error("tlsticketkeys with no answer. Generating new keys.");
        }
    }, 35000);
    // try to get keys from another node.
    var options = { 'path': '/cdn/gettlsticketkeys', 'family': 4, agent: false };
    var ccc = cdnboxStates.config.cdnboxes;
    for (var i = 0; i < ccc.length; i++) {
      if (ccc[i].isns) {
        options.protocol = ccc[i].proto;
        options.hostname = ccc[i].hostname;
        var getter = (options.protocol == "http:"?http:https);
        getter.get(options, function () {
          var cdnboxname = ccc[i].name;
          return function (res) {
              res.on('data', (d) => {
                if (cdnboxStates.tlsticketkeys === undefined && (res.statusCode === 200)) {
                  try {
                    decodeparsewritetlsticketkeys(d);
                    logerror('"error": "tlsticketkeys set from: ' + cdnboxname + '"');
                  } catch (e) {
                    logerror('"error": "tlsticketkeys parsing error from: ' + cdnboxname + e.toString().replace(/"/g,'') + '"');
                  }
                }
              });
          }
        }())
        .on('error', (e) => {
          console.error('"error gettlsticketkeys": "' + e.toString().replace(/"/g,'') + '"' + ips);
          logerror('"error": "gettlsticketkeys: ' + e.toString().replace(/"/g,'') + '"');
        });
      }
    }
}

function updatetlsticketkeys() {
    var options = { 'path': '/cdn/gettlsticketkeys', 'family': 4, agent: false };
    var lconfig = cdnboxStates.config;
    setInterval(async function () {
        var notupdated = true;
        for (var i = 0; i < lconfig.cdnboxes.length && notupdated; i++) {
          if (lconfig.cdnboxes[i].isns && cdnboxStates[lconfig.cdnboxes[i].name].status === 'on') {
            if (lconfig.cdnboxes[i].name == cdnboxStates.local.config.name) {
              // no one answers before me. I had to update keys myself
              notupdated = false;
              if (cdnboxStates.tlsticketkeys[2].timestamp < Date.now() - lconfig.tlsticketkeys.ttl) {
                cdnboxStates.tlsticketkeys[0] = cdnboxStates.tlsticketkeys[1];
                cdnboxStates.tlsticketkeys[1] = cdnboxStates.tlsticketkeys[2];
                cdnboxStates.tlsticketkeys[2] = { "key": crypto.randomBytes(48).toString('base64'),
                    "timestamp": Math.floor(Date.now() / lconfig.tlsticketkeys.ttl) * lconfig.tlsticketkeys.ttl };
                writetlsticketkeys();
                logerror('"error": "tlsticketkeys: master ' + lconfig.cdnboxes[i].name + ' updating keys."');
              }
            } else {
              // try to get keys from another node.
              await new Promise((resolve, reject) => {
                  options.protocol = lconfig.cdnboxes[i].proto;
                  options.hostname = lconfig.cdnboxes[i].hostname;
                  var getter = (options.protocol == "http:"?http:https);
                  getter.get(options, function () {
                    return function (res) {
                        res.on('data', (d) => {
                          if (res.statusCode === 200) {
                            try {
                              decodeparsewritetlsticketkeys(d);
                              logerror('"error": "tlsticketkeys refreshed from ' + lconfig.cdnboxes[i].name + '"');
                              notupdated = false;
                              resolve();
                            } catch (e) {
                              logerror('"error": "tlsticketkeys parsing error from: ' + lconfig.cdnboxes[i].name + e.toString().replace(/"/g,'') + '"');
                              reject();
                            }
                          } else {
                            logerror('"error": "tlsticketkeys status ' + res.statusCode + ' from ' + lconfig.cdnboxes[i].name + '"');
                            reject();
                          }
                        });
                    }
                  }())
                  .on('error', (e) => {
                    console.error('"error gettlsticketkeys": "' + e.toString().replace(/"/g,'') + '"');
                    logerror('"error": "gettlsticketkeys: ' + e.toString().replace(/"/g,'') + '"');
                    reject();
                  });
              }).catch((e) => { });
            }
          }
        }
    }, lconfig.tlsticketkeys.refresh);
}

function decodeparsewritetlsticketkeys(d) {

  // Use the async `crypto.scrypt()` instead.
  const key = crypto.scryptSync(cdnboxStates.config.clustersecret, 'zarbi', 16);
  var buff = JSON.parse(d);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.from(buff.iv.data));
  let decrypted = decipher.update(buff.encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  cdnboxStates.tlsticketkeys = JSON.parse(decrypted);
  writetlsticketkeys();
}

function writetlsticketkeys() {
  fs.writeFile(cdnboxStates.config.tlsticketkeys.filename,
      cdnboxStates.tlsticketkeys[0].key + "\n" + cdnboxStates.tlsticketkeys[1].key + "\n" + cdnboxStates.tlsticketkeys[2].key + "\n",
      (err) => { if (err) { logerror('"error": "tlsticketkeys write error: ' + err + '"'); }
  });
}

function testCDNBoxes() {
  if (cdnboxStates.local.config.name === undefined) { throw "Local CDNBox not detected."; }
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

