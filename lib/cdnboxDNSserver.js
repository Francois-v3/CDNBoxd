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
const timers = require('timers');
const EventEmitter = require('events').EventEmitter;
const dgram = require('dgram');
const net = require('net');

const cdnboxStates = require('./cdnboxStates.js');
const cdnboxDNSPacket = require('./cdnboxPacket.js');


class cdnboxDNSserver extends EventEmitter {

  constructor(protocol) {
    super();
    this.proto = protocol;
  }

  static newUDPServer(protocol, port, address) {

    var self = new cdnboxDNSserver(protocol);
    self.socket = dgram.createSocket(protocol);
    self.socket.on('message', function(msg, remote) {
      if (remote.port !== 0) {
        var buff = self.handleMessage(msg, remote);
        if (buff !== null) {
          self.socket.send(buff, 0, buff.length, remote.port, remote.address);
        }
      } else {
        cdnboxStates.logerror('"error": "Discarding DNS remote port 0 for ' + remote.address + '"');
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

  // push data to cdnboxDNSserver (!).
  static pushdata(dataname, data, ipv4) {
    if (!this.pushdatasocket) { this.pushdatasocket = dgram.createSocket('udp4'); }
    this.pushdatasocket.send(cdnboxDNSPacket.getpushbwpacket(dataname, data), 53, ipv4, (err) => {
        if (err !== null) {
          cdnboxStates.logerror('"error": "pushdata socket: ' + err + '"');
          this.pushdatasocket.close();
          delete this.pushdatasocket;
        }
    });
  }

  handleMessage(msg, remoteaddress) {
    var log;
    try {
      var dnspacket = new cdnboxDNSPacket(msg, cdnboxStates.config.dnsserver.attl, cdnboxStates.config.dnsserver.nsttl);
      if (dnspacket.dataname) { // data
        switch (dnspacket.dataname) {
          case "pushbwdata":
            cdnboxStates.putstatevectorhmac(dnspacket.data.toString());
            break;
          case "subscribebwdata":
            cdnboxStates.subscribelocalbw(dnspacket.data.toString());
            break;
          default:
            cdnboxStates.logerror('"Error": "handlemessage: unknow ' + dnspacket.dataname + ' dataname."');
        }
        return null;
      }
      var lcname = dnspacket.name.toLowerCase();
      var shortname = lcname.substr(0,dnspacket.name.indexOf('.'));
      if (dnspacket.qclass !== 1 || dnspacket.qtype === 12) {
        dnspacket.setresponsecode(cdnboxDNSPacket.RCODE.NOTIMP);
        log = '';
      } else if (cdnboxStates.alias.aliases[shortname] !== undefined &&
                 lcname.endsWith('.' + cdnboxStates.config.dnsserver.domain)) {
        dnspacket.addsCNAMErecord('answer', dnspacket.name,
                                  cdnboxStates.alias.aliases[shortname].target + '.' +
                                  cdnboxStates.config.dnsserver.domain + '.',
	                          cdnboxStates.alias.ttl);
        cdnboxStates.totaldnscount.current++;
	try {
	  cdnboxStates.aliasstats[shortname].count++;
	} catch (e) {
	  cdnboxStates.aliasstats[shortname]= { "count": 1 };
	}
        log = ', "adata": "CNAME ' + cdnboxStates.alias.aliases[shortname].target + '. ' +
              cdnboxStates.config.dnsserver.domain + '"';
      } else {
        log = dnsrequest(remoteaddress.address, dnspacket, shortname);
      }
      cdnboxStates.logconsole('"type": "dns", "client": "' + remoteaddress.address + '", ' +
                  '"qname": "' + dnspacket.name + '", "qtype": ' + dnspacket.qtype +
                  log + ', "rlen": ' + dnspacket.curpos + ', "rcode": ' + dnspacket.rcode);
      return dnspacket.getbuff();
    } catch (err) {
      console.error(err);
      console.error("MSG: " + remoteaddress.address, JSON.stringify(msg));
      return null;
    }
  }

  static dnsReqThrottle(cdnboxState, ratio) { 
    if (ratio !== undefined) {
      var config = cdnboxState.config, dnscount = cdnboxState.dnscount;
      if (dnscount.current > ratio * dnscount.average) {
        cdnboxStates.logconsole('"type": "limit", "cause": "Throttle DNS cdnbox ' + ratio + '", "cdnbox": "' +
            config.name + '", "data": "' + dnscount.current + '/' + dnscount.average + '"');
        return true;
      }
    }
    return false;
  }

  static dnsGlobalReqThrottle(cdnboxname, qname) { 
    var gdnscount = cdnboxStates.globaldnscount;
    if (gdnscount.limit + gdnscount.current > cdnboxStates.config.dnsserver.globalthrottlelimit * gdnscount.average) {
      cdnboxStates.logconsole('"type": "limit", "cause": "Throttle DNS global", "cdnbox": "' + cdnboxname +
                  '", "qname": "' + qname +
                  '", "data": "' + gdnscount.current + '/' + gdnscount.limit + '/' + gdnscount.average + '"');
      return true;
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
  var tdnscount = cdnboxStates.totaldnscount;
  tdnscount.average = (tdnscount.average * 59 + tdnscount.current * 60) / 60; // req per minute
  tdnscount.current = 0;
}

// reponse DNS
function dnsrequest(remoteaddress, dnspacket, shortname) {

  var reqname = dnspacket.name.toLowerCase();
  var country = (cdnboxStates.countryLookup !== null ?
	           cdnboxStates.countryLookup.get(dnspacket.ecs?dnspacket.ecsnet:remoteaddress) :
	           null);
  var log = ', "appli": "' + shortname +
    '", "country": "' + ((country && country.country)?country.country.iso_code:'none') +
    '", "rcountry": "' + ((country && country.registered_country)?country.registered_country.iso_code:'none') +
    '", "continent": "' + ((country && country.continent)?country.continent.code:'none') + '" ';
  var conf = cdnboxStates.config;
  var cbs = cdnboxStates.config.cdnboxes;
  cdnboxStates.totaldnscount.current++;
  if (reqname.endsWith('.' + conf.dnsserver.domain)) {
    var answerdata = '';
    var nslist = getnslist(country);
    var boxname = cdnboxDNSserver.choose(reqname, country, shortname);
    if (boxname != null) {
      var cdnboxstate = cdnboxStates[boxname];
      if (cdnboxstate.config.targetbw) { cdnboxStates.globaldnscount.current++; }
      cdnboxstate.dnscount.current++;
      log += (cdnboxstate.config.dnsthrottlehighratio?
              ', "dccur": ' + cdnboxstate.dnscount.current + 
              ', "dcavg": ' + cdnboxstate.dnscount.average:''
             );
      // answer (must be first)
      if (cdnboxstate.ipv4 &&
          (dnspacket.qtype == cdnboxDNSPacket.QTYPE.A || dnspacket.qtype == cdnboxDNSPacket.QTYPE.ANY)) {
        dnspacket.addsArecord('answer', dnspacket.name, cdnboxstate.ipv4n);
        answerdata += 'A ' + cdnboxstate.ipv4 + ' ';
      }
      if (cdnboxstate.ipv6 && cdnboxstate.status6 === 'on' &&
          (dnspacket.qtype == cdnboxDNSPacket.QTYPE.AAAA || dnspacket.qtype == cdnboxDNSPacket.QTYPE.ANY)) {
        dnspacket.addsAAAArecord('answer', dnspacket.name, cdnboxstate.ipv6tab);
        answerdata += 'AAAA ' + cdnboxstate.ipv6 + ' ';
      }
      if (cdnboxstate.config.cname) {
        dnspacket.addsCNAMErecord('answer', dnspacket.name, cdnboxstate.config.hostname + '.');
        answerdata += 'CNAME ' + cdnboxstate.config.hostname + '. ';
      }
      // authority (must be second), force NODATA type 2 (rfc)
      if (dnspacket.anum == 0 || dnspacket.qtype == cdnboxDNSPacket.QTYPE.ANY) { 
          dnspacket.addsSOArecord('authority', conf.dnsserver.domain + '.', cbs[nslist[0]].hostname  + '.');
          answerdata += 'SOA-Auth ';
      }
      if (dnspacket.qtype == cdnboxDNSPacket.QTYPE.A || dnspacket.qtype == cdnboxDNSPacket.QTYPE.AAAA || 
          dnspacket.qtype == cdnboxDNSPacket.QTYPE.CNAME) {
        for (var i=0; i < conf.dnsserver.nsnum && i < nslist.length; i++) {
          dnspacket.addsNSrecord('authority', conf.dnsserver.domain + '.', cbs[nslist[i]].hostname + '.');
          answerdata += 'NS-Auth ' + cbs[nslist[i]].hostname  + '. ';
        }
        for (var i=0; i < conf.dnsserver.nsnum && i < nslist.length; i++) {
          dnspacket.addsArecord('additional', cbs[nslist[i]].hostname  + '.',
              cdnboxStates[cbs[nslist[i]].name].ipv4n, conf.dnsserver.nsttl);
          if (cdnboxStates[cbs[nslist[i]].name].ipv6tab) dnspacket.addsAAAArecord('additional',
              cbs[nslist[i]].hostname  + '.', cdnboxStates[cbs[nslist[i]].name].ipv6tab, conf.dnsserver.nsttl);
          answerdata += 'NS ' + cbs[nslist[i]].hostname  + '. ';
        }
      }
      log += ', "adata": "' + answerdata + '", "cdnbox": "' + boxname + '" ';
    } else {
      dnspacket.setresponsecode(cdnboxDNSPacket.RCODE.NXDOMAIN);
      log = ', "error": "' + reqname + ' unknow." ';
    }
  } else if (reqname == conf.dnsserver.domain) {
    var nslist = getnslist(country);
    if (dnspacket.qtype == cdnboxDNSPacket.QTYPE.NS || dnspacket.qtype == cdnboxDNSPacket.QTYPE.ANY) {
      for (var i=0; i < conf.dnsserver.nsnum && i < nslist.length; i++) {
        dnspacket.addsNSrecord('answer', dnspacket.name, cbs[nslist[i]].hostname  + '.');
        answerdata += 'NS ' + cbs[nslist[i]].hostname  + '. ';
      }
      for (var i=0; i < conf.dnsserver.nsnum && i < nslist.length; i++) {
        dnspacket.addsArecord('additional', cbs[nslist[i]].hostname  + '.',
            cdnboxStates[cbs[nslist[i]].name].ipv4n, conf.dnsserver.nsttl);
        if (cdnboxStates[cbs[nslist[i]].name].ipv6tab) dnspacket.addsAAAArecord('additional',
            cbs[nslist[i]].hostname  + '.', cdnboxStates[cbs[nslist[i]].name].ipv6tab, conf.dnsserver.nsttl);
        answerdata += 'NS ' + cbs[nslist[i]].hostname  + '. ';
      }
    }
    if (dnspacket.qtype == cdnboxDNSPacket.QTYPE.SOA || dnspacket.qtype == cdnboxDNSPacket.QTYPE.ANY) {
      dnspacket.addsSOArecord('answer', conf.dnsserver.domain + '.', cbs[nslist[0]].hostname  + '.');
      answerdata += 'SOA ';
    }
    if (dnspacket.qtype == cdnboxDNSPacket.QTYPE.A || dnspacket.qtype == cdnboxDNSPacket.QTYPE.AAAA) {
      for (var i=0; i < conf.dnsserver.nsnum && i < nslist.length; i++) {
        dnspacket.addsNSrecord('authority', dnspacket.name, cbs[nslist[i]].hostname  + '.');
        answerdata += 'NS ' + cbs[nslist[i]].hostname  + '. ';
      }
    }
    log += ', "adata": "' + answerdata + '" ';
  } else {
    dnspacket.setresponsecode(cdnboxDNSPacket.RCODE.NXDOMAIN);
    log = ', "error": "' + reqname + ' unknow." ';
  }

  // adds ecs record
  if (dnspacket.ecs) {
    if ((dnspacket.qtype == cdnboxDNSPacket.QTYPE.A || dnspacket.qtype == cdnboxDNSPacket.QTYPE.AAAA ||
         dnspacket.qtype == cdnboxDNSPacket.QTYPE.CNAME) &&
        dnspacket.rcode === 0 && dnspacket.anum > 0) {
      dnspacket.addsednsecs(dnspacket.ecsmask);
    } else {
      dnspacket.addsednsecs(0);
    }
    log += ', "ednsadd": "' + dnspacket.ecsnet + '" ';
  }
  return log;
}

// genere la liste des NS en fonction de country/continent.
function getnslist(country) {
    var nslist = [], nsgrp = [], head = 0, headcont = 0, pos = 0, memolocal;
    for (var i=0; i < cdnboxStates.config.cdnboxes.length; i++) {
      var cdnbox = cdnboxStates.config.cdnboxes[i];
      if (!cdnbox.isns) continue;
      if (cdnbox.name == cdnboxStates.local.config.name) { memolocal = i; continue; }
      if (country !== null && country.country && cdnbox.countries !== undefined &&
          cdnbox.countries.indexOf(country.country.iso_code) != -1) {
        head++;
        headcont++;
        pos = Math.max(Math.floor(Math.random()*head*cdnbox.nspriorityratio, head - 1));
        nslist.splice(pos, 0, i);
        nsgrp.splice(pos, 0,cdnbox.nsgroup);
      } else if (country !== null && country.continent && cdnbox.continents !== undefined &&
          cdnbox.continents.indexOf(country.continent.code) != -1) {
        headcont++;
        pos = Math.max(Math.floor(Math.random()*(headcont - head)), headcont - head - 1) + head;
        nslist.splice(pos, 0, i);
        nsgrp.splice(pos, 0,cdnbox.nsgroup);
      } else {
        pos = Math.floor(Math.random()*(nslist.length - headcont + 1)) + headcont;
        nslist.splice(pos, 0, i);
        nsgrp.splice(pos, 0,cdnbox.nsgroup);
      }
    }
    if (country !== null && country.country && cdnboxStates.local.config.countries !== undefined &&
        cdnboxStates.local.config.countries.indexOf(country.country.iso_code) != -1) {
      nslist.splice(0,0,memolocal);
      nsgrp.splice(0,0,cdnboxStates.local.config.nsgroup);
    } else if (country !== null && country.continent && cdnboxStates.local.config.continents !== undefined &&
        cdnboxStates.local.config.continents.indexOf(country.continent.code) != -1) {
      nslist.splice(head,0,memolocal);
      nsgrp.splice(head,0,cdnboxStates.local.config.nsgroup);
    } else {
      pos = Math.floor(Math.random()*(nslist.length - headcont + 1)) + headcont;
      nslist.splice(pos,0,memolocal);
      nsgrp.splice(pos,0,cdnboxStates.local.config.nsgroup);
    }
    while (nslist.length > cdnboxStates.config.dnsserver.nsnum &&
           nsgrp[1] !== undefined && nsgrp[0] == nsgrp[1]) {
      nslist.splice(1,1);
      nsgrp.splice(1,1);
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

