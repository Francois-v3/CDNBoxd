
"use strict";
const dns = require('dns');
const http = require('http');
const https = require('https');
const timers = require('timers');
const url = require('url');
const nodemailer = require('nodemailer');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');

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

cdnboxStates.init = function (cdnboxDNSserver, choose) {

  // initialisation cdnboxStates
  var lconfig = cdnboxStates.config;
  cdnboxStates.subscribestate = {};
  cdnboxStates.subscribekey = 'Key' + Math.random() + Date.now();
  lconfig.cdnboxes.forEach(function(cdnbox) {
    var cdnboxState = cdnboxStates[cdnbox.name];
    if (!cdnboxState.config.cname) {
      dns.lookup(cdnboxState.config.hostname, { "all": true }, (err, addresses) => {
        addresses.forEach( (address) => {
          if (address.family == 4) {
            cdnboxState.ipv4 = address.address;
            if (address2iface[cdnboxState.ipv4]) { 
              cdnboxStates.local = cdnboxState; 
            }
            if (cdnbox.targetbw) {
                if (address2iface[cdnboxState.ipv4]) {
                  cdnboxState.netint = address2iface[cdnboxState.ipv4];
                  testCDNBoxes();
                  getnetcount(cdnboxState);
                  cdnboxState.bw = lconfig.dnsserver.dnsthrottlebwratio * cdnbox.targetbw + 1;
                  cdnboxState.trendbw = cdnbox.targetbw;
                  timers.setInterval( function () {
                    return function () { calcbw(cdnboxState); }}(), 2000);
                } else {
                  getremotebw(cdnbox);
                  timers.setInterval( function () {
                    return function () { getremotebw(cdnbox); }}(), 5000);
                }
            }
          } else if (address.family == 6) {
            cdnboxState.ipv6 = address.address;
          } 
        });
        if (cdnbox.name == cdnboxStates.local.config.name && cdnboxState.config.isns) {
          cdnboxDNSserver.serve(choose);
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
  Object.getOwnPropertyNames(cdnboxStates.subscribestate).forEach(pushremotebw);
  console.log(' "type": "bw", "bw": ' + cdnboxState.bw + ', "trendbw": ' + cdnboxState.trendbw + ', ' +
              '"penal": ' + Math.floor(cdnboxStates.local.config.penal + cdnboxStates.penalbucket.sigma / 4) + ', ' +
              '"score": '+ cdnboxState.score + ', "vol": ' + delta);
}


cdnboxStates.getstatevector = function(cdnboxState) {
    return '{ "name": "' + cdnboxState.config.name + '", ' +
           '"bw": ' + (cdnboxState.bw !== undefined?cdnboxState.bw:-1) + ', ' +
           '"trendbw": ' + (cdnboxState.trendbw !== undefined?cdnboxState.trendbw:-1) + ', ' + 
           '"penal": "' + cdnboxState.penal + '", ' +
           '"penal2": "' + cdnboxState.penal + '", ' +
           '"timestamp": ' + Date.now() + ', ' +
           '"status": "' + cdnboxState.status + '", ' +
           '"localtests": ' + JSON.stringify(cdnboxState.localtests) + ', ' +
           '"penalbucket": ' + cdnboxStates.penalbucket.get() + ' }';
}

cdnboxStates.putstatevector = function(statevector) {
  try {
    var data = JSON.parse(statevector), cdnboxState = cdnboxStates[data.name];
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
    if (data.penalbucket !== undefined && cdnboxState.bucket != data.penalbucket) {
      cdnboxState.bucket = data.penalbucket;
      cdnboxStates.penalbucket.calcsigma();
    }
    cdnboxState.pushupdate = Date.now();
    cdnboxState.localtests = (data.localtests === undefined?{}:data.localtests);
  } catch (e) {
    logerror('"error": "putstatevector ' + e.stack.replace(/\n/g,'').substr(0,200) + '"');
  }
}

var pushremotehttpagent = new http.Agent({ keepAlive: true, keepAliveMsecs: 3000 });
var pushremotehttpsagent = new https.Agent({ keepAlive: true, keepAliveMsecs: 3000 });
function pushremotebw(remotecdnbox) {
  var cdnboxState = cdnboxStates[remotecdnbox];
  var pushremotebwoptions = {
      protocol: cdnboxState.config.proto,
      hostname: cdnboxState.config.hostname,
      path: '/cdn/pushstates', method: 'POST',
      agent: cdnboxState.config.proto == "http:"?pushremotehttpagent:pushremotehttpsagent,
      headers: { 'Content-Type': 'application/json',
        'Subscribe-Key': cdnboxStates.subscribestate[remotecdnbox].secretkey
      }
  };
  var getter = (pushremotebwoptions.protocol == "http:"?http:https);
  var req = getter.request(pushremotebwoptions, (res) => { 
        res.on('data', (d) => {
          if (res.statusCode != 200) {
            logerror('"error": "pushstate: response: ' + res.statusCode + '"');
          }
        });
  })
  .setTimeout(1500);
  req.on('timeout', function (cdnboxState, req) {
      return function () { 
        logerror('"error": "pushstate: timeout on ' + cdnboxState.config.name + '"');
        req.abort();
      }
  }(cdnboxState, req))
  .on('error', function (cdnboxState, req) {
      return function (e) {
        logerror('"error": "pushstate: ' + e.message + ' on ' + cdnboxState.config.name + '"');
        req.abort();
      }
  }(cdnboxState, req))
  .end(cdnboxStates.getstatevector(cdnboxStates.local));
}

function getremotebw(cdnbox) {
  if (cdnboxStates.local.config.name === undefined) { return; }
  var cdnboxState = cdnboxStates[cdnbox.name];
  var cdnboxCache = cdnboxState.cache;
  if (cdnboxCache.getremotebwoptions === undefined) {
    cdnboxCache.getremotebwoptions = {
      protocol: cdnbox.proto, hostname: cdnbox.hostname, path: '/cdn/states',
      headers: { 'Subscribe-State': cdnboxStates.local.config.name,
                 'Subscribe-Key': cdnboxStates.subscribekey },
      agent: false
    };
  }
  // don't get if push allready done.
  if (cdnboxState.pushupdate !== undefined && Date.now() - cdnboxState.pushupdate < 5000) {
    return;
  }
  var getter = (cdnboxCache.getremotebwoptions.protocol == "http:"?http:https);
  getter.get(cdnboxCache.getremotebwoptions, (res) => { 
      res.on('data', (d) => { 
          if (res.statusCode != 200) {
            logerror('"error": "getremotbw: response: ' + res.statusCode + '"');
            if (cdnboxState.status === 'on') { cdnboxState.status = 'fail'; }
          } else {
            cdnboxStates.putstatevector(d.toString());
          }
      })
  })
  .setTimeout(5000)
  .on('error', (e) => {
     logerror('"error": "' + e.stack.replace(/\n/g,'').substr(0,200) + '"')
     if (cdnboxState.status === 'on') { cdnboxState.status = 'fail'; }
  });
}

function calcScore(cdnboxState) {
  if (cdnboxState.config.fixscore === undefined) {
    cdnboxState.score = cdnboxState.gettime + cdnboxState.config.addscore + cdnboxState.bucket;
  }
}

// probes perf
function getPerf(cdnbox) {
  var cdnboxState = cdnboxStates[cdnbox.name];
  if (cdnbox.fixscore !== undefined) { return; }
  var cdnboxCache = cdnboxState.cache;
  if (cdnboxCache.perfoptions === undefined) {
    var myperfURL = cdnbox.perfURL;
    if (cdnbox.perfURL === undefined) { myperfURL = cdnbox.proto + '//' + cdnbox.hostname + '/cdn/image.gif'; } 
    var pu = url.parse(myperfURL);
    cdnboxCache.perfoptions = { protocol: pu.protocol, port: pu.port, path: pu.path, agent: false };
    if (cdnboxState.netint !== undefined) {
      cdnboxCache.perfoptions.hostname = '127.0.0.1';
      cdnboxCache.perfoptions.servername = pu.hostname
    } else {
      cdnboxCache.perfoptions.hostname = cdnbox.hostname;
    }
    cdnboxCache.perfoptions.headers = { 'Host': pu.hostname, 'Connection': 'close', 'User-Agent': 'CDNBoxBot 1.0' };
  }
  var getter = (cdnboxCache.perfoptions.protocol == "http:"?http:https);
  getter.get(cdnboxCache.perfoptions, function () {
      var starttime = Date.now();
      return function (res) {
        res.on('data', (d) => {
          if (res.statusCode == 200) {
            cdnboxState.gettime = Date.now() - starttime;
            // give local trafic a bonus.
            if (cdnbox === cdnboxStates.local.config) { cdnboxState.gettime = Math.round(cdnboxState.gettime / 2); }
            calcScore(cdnboxState);
            if (cdnboxState.status === 'fail') { cdnboxState.status = 'on'; }
            console.log(' "type": "probe", "target": "' + cdnbox.name + '",' +
                        ' "time": ' + cdnboxState.gettime );
          } else {
            logerror('"error": "perfURL: ' + cdnboxState.config.perfURL + ' response: ' + res.statusCode + '"');
            cdnboxState.score = 100000;
            if (cdnboxState.status === 'on') { cdnboxState.status = 'fail'; }
          }
        });
      }
  }())
  .setTimeout(5000)
  .on('error', (e) => {
      cdnboxState.score = 100000;
      if (cdnboxState.status === 'on') { cdnboxState.status = 'fail'; }
      logerror('"error": "' + e.toString().replace(/"/g,'') + '"');
  })
  .end();
}

function testCDNBoxes() {
  cdnboxStates.penalbucket.get();
  cdnboxStates.config.cdnboxes.forEach(function(cdnbox) { 
    // dispatch measurement over time to avoid overload.
    setTimeout(() => { getPerf(cdnbox) }, 1000 + Math.floor(Math.random() * 7000));
  });
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
  var child = execFile('varnishstat', ['-j', '-1'], (error, stdout, stderr) => {
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
    lastmessages.unshift(text);
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
