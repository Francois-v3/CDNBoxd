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
const timers = require('timers');
const { execFile } = require('child_process');

const maxmind = require('maxmind');
var locationLookup = false;
var ASNLookup = false;

const cdnboxStates = require('./cdnboxStates.js');

if (cdnboxStates.config.tcprtt) {
  try {
    locationLookup = maxmind.openSync('./GeoLite2-City.mmdb');
    console.error('TCPRTT: City GeoDatabase loaded.');
    console.log(' "type": "tcprtt", "error": "City GeoDatabase loaded."');
  } catch (e) {
    try {
      locationLookup = maxmind.openSync('./GeoLite2-Country.mmdb');
      console.error('TCPRTT: Country GeoDatabase loaded.');
      console.log(' "type": "tcprtt", "error": "Country GeoDatabase loaded."');
    } catch (e) {
    }
  }
  try {
    ASNLookup = maxmind.openSync('./GeoLite2-ASN.mmdb');
    console.error('TCPRTT: ASN GeoDatabase loaded.');
    console.log(' "type": "tcprtt", "error": "ASN GeoDatabase loaded."');
  } catch (e) {
  }
}

var intervals = {};
var maxinterval = 10000;

process.on('message', (msg) => {
  console.error('Starting probe for', msg.name, 'every', msg.interval, 'ms');
  if (msg.interval > maxinterval) { maxinterval = msg.interval; }
  getPerf(msg);
  if (intervals[msg.name]) { timers.clearInterval(intervals[msg.name]); }
  intervals[msg.name] = timers.setInterval( function () { return function () { getPerf(msg); }}(), msg.interval);
});

// probes perf
function getPerf(msg) {
  setTimeout( function() {
    var getter = (msg.options.protocol == "http:"?http:https);
    getter.get(msg.options, function () {
        var starttime = Date.now();
        return function (res) {
            res.on('data', (d) => {
                var perf = Date.now() - starttime;
                // send probe only if not too late.
                if (perf < maxinterval) {
                  process.send({ "name": msg.name, 'status': res.statusCode, 'perf': perf });
                }
                console.log(' "type": "probe", "target": "' + msg.name + '",' +
                            ' "time": ' + perf + ', "status": ' + res.statusCode);
            });
        }
    }())
    .setTimeout(5000)
    .on('error', function () {
        var starttime = Date.now();
        return function (e) {
            var perf = Date.now() - starttime;
            // send probe only if not too late.
            if (perf < maxinterval) {
              process.send({ "name": msg.name, 'status': 'fail', 'perf': perf });
            }
            console.log(' "type": "probe", "target": "' + msg.name + '",' + ' "time": ' + perf + ', "status": 0');
            cdnboxStates.logerror('"error": "probe on ' + msg.name + ': ' + e.toString().replace(/"/g,'') + '"');
        }
    }());
  }, Math.round(Math.random()*4000));
}

// collect TCP RTT metrics.
if (cdnboxStates.config.tcprtt) { setInterval(() => {

  execFile('ss', ['-ntip'], { "maxBuffer": 50*1024*1024 }, (error, stdout, stderr) => {
    if (error) { throw error; }
    var findIP = /(\[?::ffff:)?([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)\]?:[0-9]+|\[?([0-9A-Fa-f]*:[0-9A-Fa-f:]+)\]?:[0-9]+/gm;
    var findrtt = /rtt:([0-9]+)/gm;
    var buff, ip2, rtt, log;
    var pos = stdout.indexOf('ESTAB');
    while (pos >= 0) {
      findIP.lastIndex = pos;
      findIP.exec(stdout);
      buff = findIP.exec(stdout);
      (buff[2] == null)?(ip2 = buff[3]):(ip2 = buff[2]);
      if (ip2 !== "127.0.0.1" && ip2 !== "::1") {
        findrtt.lastIndex = findIP.lastIndex;
        rtt = findrtt.exec(stdout)[1];
        log = ' "type": "tcprtt", "client": "' + ip2 + '",' + ' "time": ' + rtt;
        var country = locationLookup.get(ip2);
        log += ', "country": "' + ((country && country.country)?country.country.iso_code:'none') +
            '", "continent": "' + ((country && country.continent)?country.continent.code:'none') + '"' +
            ((country && country.location)?', "loc": [' + country.location.longitude + ',' +
             country.location.latitude + ']':'');
	if (ASNLookup) {
          var asn = ASNLookup.get(ip2);
          if (asn) { log += ', "aso": "' + asn.autonomous_system_organization + '"'; }
	}
        console.log(log);
      }
      pos = stdout.indexOf('ESTAB', findIP.lastIndex===0?(pos+1):findIP.lastIndex);
    }
  });

}, cdnboxStates.config.tcprtt.period?cdnboxStates.config.tcprtt.period:5000); }

