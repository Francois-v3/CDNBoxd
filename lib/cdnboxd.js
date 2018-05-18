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

const cdnboxStates = require('./cdnboxStates.js');
const cdnboxDNSserver = require('./cdnboxDNSserver.js');
const cdnboxHTTPserver = require('./cdnboxHTTPserver.js');

cdnboxStates.init(cdnboxDNSserver, choose);

// choix d'une cdnbox
function choose(reqname, country) {
  if (cdnboxStates.config.applis === undefined) { cdnboxStates.config.applis = cdnboxStates.config.applis2 }
  var appli = cdnboxStates.config.applis[reqname.substr(0,reqname.indexOf('.'))];
  if (appli === undefined) { return null; }
  var appcdnbox = appli[0], boxname = appcdnbox.cdnbox, bestScore = cdnboxStates[boxname].score;
  if (appcdnbox.fixscore !== undefined) { bestScore = appcdnbox.fixscore; }
  if (appcdnbox.addscore !== undefined) { bestScore = cdnboxStates[boxname].gettime + appcdnbox.addscore; }

  for (var i=1; i < appli.length; i++) {
    var appcdnbox = appli[i];
    var cdnboxState = cdnboxStates[appli[i].cdnbox], cdnboxconfig = cdnboxState.config;
  
    // si desactivee, non encore initialisee ou hors zone, on passe.
    if (cdnboxState.status !== "on" || cdnboxState.score === undefined) continue;
    var countries = (appcdnbox.countries !== undefined?appcdnbox.countries:cdnboxconfig.countries);
    var continents = (appcdnbox.continents !== undefined?appcdnbox.continents:cdnboxconfig.continents);
    if (countries === undefined || 
        (appcdnbox.continents !== undefined && appcdnbox.countries === undefined)) {
      if (country !== null && country.continent &&
          continents.indexOf(country.continent.code) == -1) continue;
    } else if (countries != "ALL" && country !== null && country.country &&
               countries.indexOf(country.country.iso_code) == -1) {
      continue;
    }
  
    // elimination par test local
    if (appcdnbox.localtests) {
      var testresult = true;
      for (var j = 0; j < appcdnbox.localtests.length; j++) {
        testresult = testresult && cdnboxState.localtests[appcdnbox.localtests[j]];
      }
      if (!testresult) continue;
    }

    // gestion de la saturation de BP. Si sature on passe.
    if (cdnboxState.bw > cdnboxconfig.ceilbw) {
        console.log(' "type": "limit", "cause": "Limitation BP max' + cdnboxconfig.ceilbw +
                      '", "cdnbox": "' + cdnboxconfig.name + '"');
      continue;
    }
    if (cdnboxState.bw > cdnboxconfig.floorbw) {
      var delta = cdnboxState.bw - cdnboxconfig.floorbw, base = cdnboxconfig.ceilbw - cdnboxconfig.floorbw;
      if (Math.random() * base < delta) {
        console.log(' "type": "limit", "cause": "Limitation BP delta ' + Math.floor(delta / 10) +
                    '", "cdnbox": "' + cdnboxconfig.name + '"');
        continue;
      }
    }
  
    // throttle DNS req
    if (cdnboxState.bw !== undefined && !appli[0].dontthrottle) {
      if (cdnboxState.bw > cdnboxconfig.targetbw * cdnboxStates.config.dnsserver.globalthrottlebwratio && 
          cdnboxDNSserver.dnsGlobalReqThrottle(cdnboxState)) { continue; }
      if (cdnboxDNSserver.dnsReqThrottle(cdnboxState, 
          (cdnboxState.bw > cdnboxconfig.dnsthrottlebwratio * cdnboxconfig.targetbw?
              cdnboxconfig.dnsthrottlehighratio:cdnboxconfig.dnsthrottlelowratio)
           )) {
        continue;
      }
    }
  
    // on retient si meilleur score.
    var score = cdnboxState.score;
    if (appcdnbox.fixscore !== undefined) { score = appcdnbox.fixscore; }
      if (appcdnbox.addscore !== undefined) { score = cdnboxStates[boxname].gettime + appcdnbox.addscore; }
      if (score < bestScore) {
        boxname = cdnboxconfig.name;
        bestScore = score;
    }
  }
  return boxname;
}

