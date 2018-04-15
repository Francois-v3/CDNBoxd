
"use strict";
const dnsserver = require('native-dns');
const dnsconsts = require('native-dns-packet').consts;
const timers = require('timers');
const maxmind = require('maxmind');

const cdnboxStates = require('./cdnboxStates.js');

const countryLookup = maxmind.openSync('./GeoLite2-Country.mmdb');

var udp6dnsserver = dnsserver.createServer({ dgram_type: 'udp6' });
udp6dnsserver.on('request', function (request, response) { dnsrequest(request, response); } );
udp6dnsserver.on('error', function (err, buff, req, res) { console.error(err.stack); });
udp6dnsserver.on('listening', () => {
    console.error("DNS UDP6 server launched on port %s", cdnboxStates.config.dnsserver.port);
});

var udpdnsserver = dnsserver.createServer({ dgram_type: 'udp4' });
udpdnsserver.on('request', function (request, response) { dnsrequest(request, response); } );
udpdnsserver.on('error', function (err, buff, req, res) { console.error(err.stack); });
udpdnsserver.on('listening', () => {
    console.error("DNS UDP4 server launched on port %s", cdnboxStates.config.dnsserver.port);
});

var tcpdnsserver = dnsserver.createTCPServer();
tcpdnsserver.on('request', function (request, response) { dnsrequest(request, response); } );
tcpdnsserver.on('error', function (err, buff, req, res) { console.error(err.stack); });
tcpdnsserver.on('listening', () => {
    console.error("DNS TCP server launched on port %s", cdnboxStates.config.dnsserver.port);
});

var cdnboxDNSserver = module.exports = function () { };

cdnboxDNSserver.serve = function (choose) {
  cdnboxDNSserver.choose = choose;
  calcdnscount();
  timers.setInterval(calcdnscount, 1000);
  udpdnsserver.serve(cdnboxStates.config.dnsserver.port, '0.0.0.0');
  tcpdnsserver.serve(cdnboxStates.config.dnsserver.port);
}

function calcdnscount() {
  for (var i=0; i < cdnboxStates.config.cdnboxes.length; i++) {
    var dnscount = cdnboxStates[cdnboxStates.config.cdnboxes[i].name].dnscount;
    dnscount.average = (dnscount.average * 9 + dnscount.current) / 10;
    if (dnscount.average < cdnboxStates.config.dnsserver.dnscountavgmin) {
      dnscount.average = cdnboxStates.config.dnsserver.dnscountavgmin;
    }
    dnscount.last = dnscount.current;
    dnscount.current = 0;
  }
  var gdnscount = cdnboxStates.globaldnscount;
  gdnscount.average = (gdnscount.average * 9 + gdnscount.current) / 10;
  if (gdnscount.average < cdnboxStates.config.dnsserver.dnscountavgmin) {
    gdnscount.average = cdnboxStates.config.dnsserver.dnscountavgmin;
  }
  gdnscount.limit += gdnscount.current - cdnboxStates.config.dnsserver.dnscountdownratio * gdnscount.average;
  if (gdnscount.limit < 0) { gdnscount.limit = 0; }
  gdnscount.last = gdnscount.current;
  gdnscount.current = 0;
}

cdnboxDNSserver.dnsReqThrottle = function (cdnboxState, ratio) { 
  if (ratio !== undefined) {
    var config = cdnboxState.config, dnscount = cdnboxState.dnscount;
    if (dnscount.current > ratio * dnscount.average) {
      console.log(' "type": "limit", "cause": "Throttle DNS cdnbox ' + ratio + '", "cdnbox": "' +
          config.name + '", "data": "' + dnscount.current + '/' + dnscount.average + '"');
      return true;
    }
  }
  return false;
}

cdnboxDNSserver.dnsGlobalReqThrottle = function (cdnboxState) { 
  if (cdnboxState.config.dnsthrottlelowratio !== undefined ||
      cdnboxState.config.dnsthrottlehighratio !== undefined) {
    var config = cdnboxState.config, gdnscount = cdnboxStates.globaldnscount;
    if (gdnscount.limit + gdnscount.current > cdnboxStates.config.dnsserver.globalthrottlelimit * gdnscount.average) {
      console.log(' "type": "limit", "cause": "Throttle DNS global", "cdnbox": "' + config.name +
          '", "data": "' + gdnscount.current + '/' + gdnscount.limit + '/' + gdnscount.average + '"');
      return true;
    }
  }
  return false;
}

cdnboxDNSserver.serveIPv6 = function (ip6addr) { 
  udp6dnsserver.serve(cdnboxStates.config.dnsserver.port, ip6addr); 
}

// reponse DNS
function dnsrequest(request, response) {

  var req = request.question[0], reqname = req.name.toLowerCase(), resp = response.answer;
  if (reqname.endsWith(cdnboxStates.config.dnsserver.domain)) {

    var address = request.address.address, answerdata = '';
    var ednsadd = ednsaddress(request.edns);
    var country = countryLookup.get(ednsadd?ednsadd:address);
    var boxname = cdnboxDNSserver.choose(reqname, country);
    if (boxname != null) { cdnboxStates[boxname].dnscount.current++; }
    cdnboxStates.globaldnscount.current++;
    
    response.header.aa = 1;
    response.edns_version = 0;
    if ((req.type == dnsconsts.NAME_TO_QTYPE.NS || req.type == dnsconsts.NAME_TO_QTYPE.ANY) && 
        reqname == cdnboxStates.config.dnsserver.domain) {
      var nslist = getnslist(country);
      for (var i=0; i < cdnboxStates.config.dnsserver.nsnum && i < nslist.length; i++) {
        resp.push(dnsserver.NS({ name: req.name, data: nslist[i] + '.', ttl: cdnboxStates.config.dnsserver.nsttl }));
        answerdata += 'NS ' + nslist[i] + '. ';
      }
    }
    if (req.type == dnsconsts.NAME_TO_QTYPE.A || req.type == dnsconsts.NAME_TO_QTYPE.AAAA || 
        req.type == dnsconsts.NAME_TO_QTYPE.CNAME) {
      var nslist = getnslist(country);
      for (var i=0; i < cdnboxStates.config.dnsserver.nsnum && i < nslist.length; i++) {
        response.authority.push(dnsserver.NS({
            name: cdnboxStates.config.dnsserver.domain + '.', data: nslist[i] + '.', ttl: cdnboxStates.config.dnsserver.nsttl
        }));
        answerdata += 'NS-Auth ' + nslist[i] + '. ';
      }
    }
    if (req.type == dnsconsts.NAME_TO_QTYPE.SOA || req.type == dnsconsts.NAME_TO_QTYPE.ANY ||
        (req.type == dnsconsts.NAME_TO_QTYPE.NS && reqname != cdnboxStates.config.dnsserver.domain)) {
        var nslist = getnslist(country);;
        response.answer.push(dnsserver.SOA({
            name: cdnboxStates.config.dnsserver.domain+'.', primary: nslist[0] + '.', admin: 'francois.veux.name',
            serial: "2017113022", refresh: 43200, retry: 3600, expiration: 1209600, minimum: 600,
            ttl: cdnboxStates.config.dnsserver.nsttl
        }));
        answerdata += 'SOA ';
    }

    if (boxname != null) {
      if (req.type == dnsconsts.NAME_TO_QTYPE.AAAA && !cdnboxStates[boxname].ipv6 &&
          !cdnboxStates[boxname].config.cname) {
        var nslist = getnslist(country);;
        response.authority.push(dnsserver.SOA({
             name: cdnboxStates.config.dnsserver.domain+'.', primary: nslist[0] + '.', admin: 'francois.veux.name',
             serial: "2017113022", refresh: 43200, retry: 3600, expiration: 1209600, minimum: 600,
             ttl: cdnboxStates.config.dnsserver.nsttl }));
        answerdata += 'SOA-Auth ';
      }
      if (cdnboxStates[boxname].ipv4 &&
          (req.type == dnsconsts.NAME_TO_QTYPE.A || req.type == dnsconsts.NAME_TO_QTYPE.ANY)) {
        resp.push(dnsserver.A({
            name: req.name, address: cdnboxStates[boxname].ipv4, ttl: cdnboxStates.config.dnsserver.attl,
        }));
        answerdata += 'A ' + cdnboxStates[boxname].ipv4 + ' ';
      }
      if (cdnboxStates[boxname].ipv6 &&
          (req.type == dnsconsts.NAME_TO_QTYPE.AAAA || req.type == dnsconsts.NAME_TO_QTYPE.ANY)) {
        resp.push(dnsserver.AAAA({
            name: req.name, address: cdnboxStates[boxname].ipv6, ttl: cdnboxStates.config.dnsserver.attl,
        }));
        answerdata += 'AAAA ' + cdnboxStates[boxname].ipv6 + ' ';
      }
      if (cdnboxStates[boxname].config.cname) {
        resp.push(dnsserver.CNAME({
            name: req.name, data: cdnboxStates[boxname].config.hostname + '.', ttl: cdnboxStates.config.dnsserver.attl
        }));
        answerdata += 'CNAME ' + cdnboxStates[boxname].config.hostname + '. ';
      }
    }
    console.log(' "type": "dns", "client": "' + request.address.address + '", "ednsadd": "' + ednsadd +
        '", "country": "' + ((country && country.country)?country.country.iso_code:'none') +
        '", "rcountry": "' +
        ((country && country.registered_country)?country.registered_country.iso_code:'none') +
        '", "continent": "' +
        ((country && country.continent)?country.continent.code:'none') +
        '", "cdnbox": "' + boxname + '", "anum": ' + (resp.length + response.authority.length) +
        ', "qnum": ' + request.question.length + ', "qname": "' + reqname + '", "qtype": ' + req.type +
        ', "adata": "' + answerdata + '"' +
        ', "dcgcur": ' + cdnboxStates.globaldnscount.current +
        ', "dcgavg": ' + cdnboxStates.globaldnscount.average +
        ', "dcglim": ' + cdnboxStates.globaldnscount.limit +
        (boxname!=null && cdnboxStates[boxname].config.dnsthrottlehighratio?
            ', "dccur": ' + cdnboxStates[boxname].dnscount.current + 
            ', "dcavg": ' + cdnboxStates[boxname].dnscount.average:''
        ) + ' ');
  }
  response.send();
}

// genere la liste des NS en fonction de country/continent.
function getnslist(country) {
    var nslist = [], nsgrp = [], head = 0, headcont = 0, pos = 0;
    for (var i=0; i < cdnboxStates.config.cdnboxes.length; i++) {
      var cdnbox = cdnboxStates.config.cdnboxes[i];
      if (!cdnbox.isns) continue;
      if (cdnbox.name == cdnboxStates.local.config.name) continue;
      if (country !== null && country.country && cdnbox.countries !== undefined &&
          cdnbox.countries.indexOf(country.country.iso_code) != -1) {
        head++;
        headcont++;
        pos = Math.max(Math.floor(Math.random()*head*cdnbox.nspriorityratio, head - 1));
        nslist.splice(pos, 0,cdnbox.hostname);
        nsgrp.splice(pos, 0,cdnbox.nsgroup);
      } else if (country !== null && country.continent && cdnbox.continents !== undefined &&
          cdnbox.continents.indexOf(country.continent.code) != -1) {
        headcont++;
        pos = Math.max(Math.floor(Math.random()*(headcont - head)), headcont - head - 1) + head;
        nslist.splice(pos, 0,cdnbox.hostname);
        nsgrp.splice(pos, 0,cdnbox.nsgroup);
      } else {
        pos = Math.floor(Math.random()*(nslist.length - headcont + 1)) + headcont;
        nslist.splice(pos, 0,cdnbox.hostname);
        nsgrp.splice(pos, 0,cdnbox.nsgroup);
      }
    }
    if (country !== null && country.country && cdnboxStates.local.config.countries !== undefined &&
        cdnboxStates.local.config.countries.indexOf(country.country.iso_code) != -1) {
      nslist.splice(0,0,cdnboxStates.local.config.hostname);
      nsgrp.splice(0,0,cdnboxStates.local.config.nsgroup);
    } else if (country !== null && country.continent && cdnboxStates.local.config.continents !== undefined &&
        cdnboxStates.local.config.continents.indexOf(country.continent.code) != -1) {
      nslist.splice(head,0,cdnboxStates.local.config.hostname);
      nsgrp.splice(head,0,cdnboxStates.local.config.nsgroup);
    } else {
      pos = Math.floor(Math.random()*(nslist.length - headcont + 1)) + headcont;
      nslist.splice(pos,0,cdnboxStates.local.config.hostname);
      nsgrp.splice(pos,0,cdnboxStates.local.config.nsgroup);
    }
    while (nslist.length > cdnboxStates.config.dnsserver.nsnum &&
           nsgrp[1] !== undefined && nsgrp[0] == nsgrp[1] &&
           nsgrp[2] !== undefined && nsgrp[0] == nsgrp[2]) {
      nslist.splice(2,1);
      nsgrp.splice(2,1);
    }
    return nslist;
}

// decodage de l'adresse EDNS.
function ednsaddress (ednsdata) {
  if (ednsdata && ednsdata.options[0] && ednsdata.options[0].code == 8) {
    var data = ednsdata.options[0].data, proto = 256 * data[0] + data[1], subnetl = data[2];
    if (proto == 1 && (subnetl >= 17 && subnetl <= 24)) {
      return '' +  data[4] + '.' + data[5] + '.' +  data[6] + '.0';
    } else if (proto == 1 && subnetl >= 25) {
      return '' +  data[4] + '.' + data[5] + '.' +  data[6] + '.' + data[7];
    } else if (proto == 2 && subnetl == 56) {
      return data.toString('hex', 4, 6) + ':' + data.toString('hex', 6, 8) + ':' + 
             data.toString('hex', 8, 10) + ':' + data.toString('hex', 10, 11) + '00::';
    }
    console.error("EDNS: proto %s ou subnetl %s inconnu", proto, subnetl);
  }
  return null;
}

