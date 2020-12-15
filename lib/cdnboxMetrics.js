// Copyright 2018 Francois Veux <francois@veux.name>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the 'Software'), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE

'use strict';
const childProcess = require('child_process');

var cdnboxMetrics = module.exports = {};

// eventloop metric.
cdnboxMetrics.eventloop = function (el) {

  if (el.memotime === undefined) {
    el.memotime = process.hrtime();
    el.max = el.cumul = el.count = 0;
    el.last = {};
    el.topmetric = el.memotime[0];
  }
  var lasttime = process.hrtime();
  var delta = ((lasttime[0]-el.memotime[0])*1000000000 + lasttime[1]-el.memotime[1]);
  if (lasttime[0] - el.topmetric >= 10) {
    el.topmetric = lasttime[0];
    el.last.count = el.count;
    el.last.cumul = el.cumul;
    el.last.max = el.max;
    el.max = el.cumul = el.count = 0;
  }
  el.count++;
  el.cumul += delta;
  if (delta > el.max) el.max = delta;
  el.memotime = lasttime;
  setTimeout(cdnboxMetrics.eventloop, 5, el);
}

cdnboxMetrics.getvarnishmetrics = function(cdnboxStates) {
  return new Promise((resolve, reject) => {
    var child = childProcess.execFile('varnishstat', ['-j', '-1'], (error, stdout, stderr) => {
      if (error) {
        console.error(error);
        cdnboxStates.logerror('"error": "varnishmetrics: ' + error.toString().replace(/"|\n/g,'') +
		              ' on ' + cdnboxStates.local.config.name + '"');
	resolve(',"error": "varnishmetrics error. See error log."');
      } else {
        var i,
	    vconf = cdnboxStates.config.varnishmetrics,
            vconf_keys = Object.keys(vconf);
        try {
          var vstat = JSON.parse(stdout), buff = '', currenttime = Date.now();
          if (vstat.counters !== undefined) { vstat = vstat.counters; }
          var delta = (currenttime - (cdnboxStates.varnishmetrics.lasttime?cdnboxStates.varnishmetrics.lasttime:0)) / 1000;
          cdnboxStates.varnishmetrics.lasttime = currenttime;
          for (i = 0; i < vconf_keys.length; i++) {
            if (vstat[vconf[vconf_keys[i]]]) {
              switch (vstat[vconf[vconf_keys[i]]].flag) {
                case 'c':
                  if (cdnboxStates.varnishmetrics[vconf_keys[i]] !== undefined &&
		      cdnboxStates.varnishmetrics[vconf_keys[i]] <= vstat[vconf[vconf_keys[i]]].value) {
                    buff += ',"' + vconf_keys[i] + '": ' +
                        Math.round((vstat[vconf[vconf_keys[i]]].value - cdnboxStates.varnishmetrics[vconf_keys[i]]) / delta); 
                  }
                  cdnboxStates.varnishmetrics[vconf_keys[i]] = vstat[vconf[vconf_keys[i]]].value;
                  break;
                case 'g':
                  buff += ',"' + vconf_keys[i] + '": ' + vstat[vconf[vconf_keys[i]]].value; 
              }
            } else {
              buff += ',"' + vconf_keys[i] + '": -1';
            }
          }
	  resolve(buff);
        } catch (err) {
          console.error(err);
          cdnboxStates.logerror('"error": "varnishmetrics: ' + err.message + 'on ' + vconf[vconf_keys[i]] +
		   ' on ' + cdnboxStates.local.config.name + '"');
	  resolve(',"error": "varnishmetrics error. See error log."');
        }
      }
    });
  })
}

