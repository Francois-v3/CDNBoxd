
"use strict";
const timers = require('timers');
const EventEmitter = require('events').EventEmitter;
const dgram = require('dgram');
const net = require('net');
const dnsconsts = require('native-dns-packet').consts;
const NDPPacket = require('native-dns-packet');

const maxmind = require('maxmind');
const countryLookup = maxmind.openSync('./GeoLite2-Country.mmdb');

const cdnboxStates = require('./cdnboxStates.js');


class cdnboxDNSserver extends EventEmitter {

  constructor(protocol) {
    super();
    this.proto = protocol;
  }

  static newUDPServer(protocol, port, address) {

    var self = new cdnboxDNSserver(protocol);
    self.socket = dgram.createSocket(protocol);
    self.socket.on('message', function(msg, remote) {
      var buff = self.handleMessage(msg, remote);
      if (buff !== null) {
        self.socket.send(buff, 0, buff.length, remote.port, remote.address);
      }
    });
    self.socket.on('listening', function() {
      console.error("DNS %s server launched on port %s", self.proto, cdnboxStates.config.dnsserver.port);
    });
    self.socket.on('error', function(err) { self.emit('error', err, self.socket); });
    self.socket.bind(port, address);
    return self;
  }

  static newTCPServer(protocol, port, address) {

    var self = new cdnboxDNSserver(protocol);
    self.socket = net.createServer(function(client) {
      var recvbuff = Buffer.allocUnsafe(512), qlen, recvlen = 0;
      client.on('data', function(data) {

        // if buffer is too small, extend it. 
        if (data.length + recvlen > recvbuff.length) {
          var oldbuff = recvbuff;
          recvbuff = Buffer.allocUnsafe(1024 + data.length + recvlen);
          oldbuff.copy(recvbuff);
        }

        data.copy(recvbuff, recvlen);
        recvlen += data.length;

        while (recvlen > 2) {
          qlen = recvbuff.readUInt16BE(0);
          if (recvlen >= qlen + 2) {
            // construct and send answer.
            var buff = self.handleMessage(recvbuff.slice(2, qlen + 2), client.address());
            if (buff !== null) {
              var buff2 = Buffer.allocUnsafe(2);
              buff2.writeUInt16BE(buff.length, 0);
              client.write(buff2);
              client.write(buff);
            }
      
            // remove question
            recvbuff.copy(recvbuff, 0, qlen + 2, recvlen);
            recvlen -= qlen + 2;
          } else {
            break;
          }
        }
      });
    });
    self.socket.on('listening', function() {
      console.error("DNS %s server launched on port %s", self.proto, cdnboxStates.config.dnsserver.port);
    });
    self.socket.on('error', function(err) { self.emit('error', err, self.socket); });
    self.socket.listen(port, address);
    return self;
  }

  static serve(choose, ip4addr) {
    cdnboxDNSserver.choose = choose;
    calcdnscount();
    timers.setInterval(calcdnscount, 1000);
    cdnboxDNSserver.newUDPServer('udp4', cdnboxStates.config.dnsserver.port, ip4addr);
    cdnboxDNSserver.newTCPServer('tcp4', cdnboxStates.config.dnsserver.port, ip4addr);
  }

  static serveIPv6(ip6addr) { 
    cdnboxDNSserver.newUDPServer('udp6', cdnboxStates.config.dnsserver.port, ip6addr); 
    cdnboxDNSserver.newTCPServer('tcp6', cdnboxStates.config.dnsserver.port, ip6addr); 
  }

  handleMessage(msg, remoteaddress) {

    var request, buff, log, ednsadd, response = new NDPPacket();
    try {
      request = NDPPacket.parse(msg);

      response.header.id = request.header.id;
      response.header.qr = 1;
      response.header.aa = 1;
      response.question = request.question;

      // EDNS ECS
      ednsadd = ednsaddress(request.edns);
      log = dnsrequest(request.question[0], response, ednsadd?ednsadd:remoteaddress.address);
      if (ednsadd) {
        response.edns = request.edns;
        if ((request.question[0].type == dnsconsts.NAME_TO_QTYPE.A ||
             request.question[0].type == dnsconsts.NAME_TO_QTYPE.AAAA ||
             request.question[0].type == dnsconsts.NAME_TO_QTYPE.CNAME) &&
            response.header.rcode === 0 &&
            response.answer.length > 0) {
          response.edns.options[0].data[3] = response.edns.options[0].data[2];
        } else {
          response.edns.options[0].data[3] = 0;
        }
        response.additional.push(response.edns);
      }
      buff = new Buffer.allocUnsafe(1024);
      var len = NDPPacket.write(buff, response);
      console.log(' "type": "dns", "client": "' + remoteaddress.address +
          '", "ednsadd": "' + ednsadd + '", ' + log + ', "rlen": ' + len);
      return buff.slice(0,len);
    } catch (err) {
      console.error(err.stack);
      return null;
    }
  }

  static dnsReqThrottle(cdnboxState, ratio) { 
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

  static dnsGlobalReqThrottle(cdnboxState) { 
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

}
module.exports = cdnboxDNSserver;

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

// reponse DNS
function dnsrequest(req, response, remoteaddress) {

  var reqname = req.name.toLowerCase();
  if (reqname.endsWith('.' + cdnboxStates.config.dnsserver.domain)) {

    var answerdata = '';
    var country = countryLookup.get(remoteaddress);
    var boxname = cdnboxDNSserver.choose(reqname, country);
    if (boxname != null) { cdnboxStates[boxname].dnscount.current++; }
    cdnboxStates.globaldnscount.current++;
    
    if ((req.type == dnsconsts.NAME_TO_QTYPE.NS || req.type == dnsconsts.NAME_TO_QTYPE.ANY) && 
        reqname == cdnboxStates.config.dnsserver.domain) {
      var nslist = getnslist(country);
      for (var i=0; i < cdnboxStates.config.dnsserver.nsnum && i < nslist.length; i++) {
        response.answer.push({ "type":dnsconsts.NAME_TO_QTYPE.NS,"class":1,"name": req.name, data: nslist[i] + '.',
                    "ttl": cdnboxStates.config.dnsserver.nsttl });
        answerdata += 'NS ' + nslist[i] + '. ';
      }
    }
    if (req.type == dnsconsts.NAME_TO_QTYPE.A || req.type == dnsconsts.NAME_TO_QTYPE.AAAA || 
        req.type == dnsconsts.NAME_TO_QTYPE.CNAME) {
      var nslist = getnslist(country);
      for (var i=0; i < cdnboxStates.config.dnsserver.nsnum && i < nslist.length; i++) {
        response.authority.push({ "type":dnsconsts.NAME_TO_QTYPE.NS,"class":1,
            "name": cdnboxStates.config.dnsserver.domain + '.', "data": nslist[i] + '.',
            "ttl": cdnboxStates.config.dnsserver.nsttl });
        answerdata += 'NS-Auth ' + nslist[i] + '. ';
      }
    }
    if (req.type == dnsconsts.NAME_TO_QTYPE.SOA || req.type == dnsconsts.NAME_TO_QTYPE.ANY ||
        (req.type == dnsconsts.NAME_TO_QTYPE.NS && reqname != cdnboxStates.config.dnsserver.domain)) {
        var nslist = getnslist(country);;
        response.answer.push({"type":dnsconsts.NAME_TO_QTYPE.SOA,"class":1,
            "name": cdnboxStates.config.dnsserver.domain+'.',"primary": nslist[0] + '.',"admin": 'francois.veux.name',
            "serial":"2017113022", "refresh":43200, "retry": 3600,"expiration": 1209600,"minimum": 600,
            "ttl": cdnboxStates.config.dnsserver.nsttl });
        answerdata += 'SOA ';
    }

    if (boxname != null) {
      if (req.type == dnsconsts.NAME_TO_QTYPE.AAAA && !cdnboxStates[boxname].ipv6 &&
          !cdnboxStates[boxname].config.cname) {
        var nslist = getnslist(country);;
        response.authority.push({"type":dnsconsts.NAME_TO_QTYPE.SOA,"class":1,
            "name": cdnboxStates.config.dnsserver.domain+'.', "primary": nslist[0] + '.',
            "admin": 'francois.veux.name',"serial": "2017113022","refresh": 43200, "retry": 3600,
            "expiration": 1209600, "minimum": 600, "ttl": cdnboxStates.config.dnsserver.nsttl });
        answerdata += 'SOA-Auth ';
      }
      if (cdnboxStates[boxname].ipv4 &&
          (req.type == dnsconsts.NAME_TO_QTYPE.A || req.type == dnsconsts.NAME_TO_QTYPE.ANY)) {
        response.answer.push({ "type":dnsconsts.NAME_TO_QTYPE.A,"class":1, "name": req.name,
                    "address": cdnboxStates[boxname].ipv4, "ttl": cdnboxStates.config.dnsserver.attl });
        answerdata += 'A ' + cdnboxStates[boxname].ipv4 + ' ';
      }
      if (cdnboxStates[boxname].ipv6 &&
          (req.type == dnsconsts.NAME_TO_QTYPE.AAAA || req.type == dnsconsts.NAME_TO_QTYPE.ANY)) {
        response.answer.push({ "type":dnsconsts.NAME_TO_QTYPE.AAAA,"class":1, "name": req.name,
                    "address": cdnboxStates[boxname].ipv6, ttl: cdnboxStates.config.dnsserver.attl });
        answerdata += 'AAAA ' + cdnboxStates[boxname].ipv6 + ' ';
      }
      if (cdnboxStates[boxname].config.cname) {
        response.answer.push({ "type": dnsconsts.NAME_TO_QTYPE.CNAME,"class":1, "name": req.name,
                    "data": cdnboxStates[boxname].config.hostname + '.', "ttl": cdnboxStates.config.dnsserver.attl });
        answerdata += 'CNAME ' + cdnboxStates[boxname].config.hostname + '. ';
      }
    }
    return ' "country": "' + ((country && country.country)?country.country.iso_code:'none') +
        '", "rcountry": "' + ((country && country.registered_country)?country.registered_country.iso_code:'none') +
        '", "continent": "' + ((country && country.continent)?country.continent.code:'none') +
        '", "cdnbox": "' + boxname + '", "anum": ' + (response.answer.length + response.authority.length) +
        ', "qname": "' + reqname + '", "qtype": ' + req.type + ', "adata": "' + answerdata + '"' +
        ', "dcgcur": ' + cdnboxStates.globaldnscount.current +
        ', "dcgavg": ' + cdnboxStates.globaldnscount.average +
        ', "dcglim": ' + cdnboxStates.globaldnscount.limit +
        (boxname!=null && cdnboxStates[boxname].config.dnsthrottlehighratio?
            ', "dccur": ' + cdnboxStates[boxname].dnscount.current + 
            ', "dcavg": ' + cdnboxStates[boxname].dnscount.average:''
        ) + ' ';
  } else {
    response.header.rcode = dnsconsts.NAME_TO_RCODE.NOTFOUND;
    return ' "error": "' + reqname + ' unknow." ';
  }
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

