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

const cdnboxStates = require('./cdnboxStates.js');

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
}

