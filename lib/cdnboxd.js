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

const cdnboxHTTPserver = require('./cdnboxHTTPserver.js');
const cdnboxDNSserver = require('./cdnboxDNSserver.js');
const cdnboxStates = require('./cdnboxStates.js');

cdnboxStates.loadconfig().then ( () => {
  cdnboxHTTPserver.init(cdnboxStates);
  cdnboxStates.init(cdnboxDNSserver, choose);
});

// choix d'une cdnbox
function choose(reqname, country, shortname) {
  let appli = cdnboxStates.config.applis[shortname];
  if (appli === undefined) { return null; }
  cdnboxStates.applistats[shortname].count++;
  let appcdnbox = appli[0], boxname = appcdnbox.cdnbox, 
      bestScore = cdnboxStates[boxname].score, status = cdnboxStates[boxname].status;
  if (appcdnbox.fixscore !== undefined) { bestScore = appcdnbox.fixscore; }
  if (appcdnbox.addscore !== undefined) { bestScore = cdnboxStates[boxname].gettime + appcdnbox.addscore; }

  for (let i=1; i < appli.length; i++) {
    let appcdnbox = appli[i];
    let cdnboxState = cdnboxStates[appli[i].cdnbox], cdnboxconfig = cdnboxState.config;
  
    // si le status n'est pas on et la cdnbox ok, on prends incoditionnellement.
    if (cdnboxState.status === "on" && cdnboxconfig.ishttp === true && status !== "on") {
      boxname = cdnboxconfig.name;
      status = cdnboxState.status;
      bestScore = cdnboxState.score;
    }

    // si desactivee, non encore initialisee ou hors zone, on passe.
    if (cdnboxState.status !== "on" || cdnboxconfig.ishttp === false || cdnboxState.score === undefined) continue;
    let countries = (appcdnbox.countries !== undefined?appcdnbox.countries:cdnboxconfig.countries);
    let continents = (appcdnbox.continents !== undefined?appcdnbox.continents:cdnboxconfig.continents);
    if (countries === undefined || 
        (appcdnbox.continents !== undefined && appcdnbox.countries === undefined)) {
      if (country !== null && country.continent &&
          continents.indexOf(country.continent.code) == -1) continue;
    } else if (countries != "ALL" && country !== null && 
	       country.country && countries.indexOf(country.country.iso_code) == -1 &&
	       (continents === undefined || 
		(country.continent && continents.indexOf(country.continent.code) == -1))) {
      continue;
    }
  
    // elimination par test local
    if (appcdnbox.localtests) {
      let testresult = true;
      for (let j = 0; j < appcdnbox.localtests.length; j++) {
        testresult = testresult && cdnboxState.localtests[appcdnbox.localtests[j]];
      }
      if (!testresult) continue;
    }

    // gestion de la saturation de BP. Si sature on passe.
    if (cdnboxState.bw > cdnboxconfig.ceilbw) {
        cdnboxStates.logconsole('"type": "limit", "cause": "Limitation BP max' + cdnboxconfig.ceilbw +
                      '", "cdnbox": "' + cdnboxconfig.name + '"');
      continue;
    }
    if (cdnboxState.bw > cdnboxconfig.floorbw) {
      let delta = cdnboxState.bw - cdnboxconfig.floorbw, base = cdnboxconfig.ceilbw - cdnboxconfig.floorbw;
      if (Math.random() * base < delta) {
        cdnboxStates.logconsole('"type": "limit", "cause": "Limitation BP delta ' + Math.floor(delta / 10) +
                    '", "cdnbox": "' + cdnboxconfig.name + '"');
        continue;
      }
    }
  
    // throttle DNS req
    if (cdnboxState.bw !== undefined) {
      if (cdnboxState.bw > cdnboxconfig.targetbw * cdnboxStates.config.dnsserver.globalthrottlebwratio && 
          cdnboxDNSserver.dnsGlobalReqThrottle(cdnboxState.config.name, reqname)) { continue; }
      if (cdnboxDNSserver.dnsReqThrottle(cdnboxState, 
          (cdnboxState.bw > cdnboxconfig.dnsthrottlebwratio * cdnboxconfig.targetbw?
              cdnboxconfig.dnsthrottlehighratio:cdnboxconfig.dnsthrottlelowratio)
           )) {
        continue;
      }
    }
  
    // on retient si meilleur score.
    let score = cdnboxState.score;
    if (appcdnbox.fixscore !== undefined) { score = appcdnbox.fixscore; }
    if (appcdnbox.addscore !== undefined) { score = cdnboxStates[boxname].gettime + appcdnbox.addscore; }
    if (score < bestScore) {
      boxname = cdnboxconfig.name;
      bestScore = score;
    }
  }
  cdnboxStates.applistats[shortname][boxname].count++;
  return boxname;
}

