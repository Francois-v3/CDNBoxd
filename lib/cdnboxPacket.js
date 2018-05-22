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

const DNSConsts = require('./cdnboxDNSConsts.js');

class cdnboxDNSPacket {

  constructor(msg, attl, nsttl) {

    this.dico = {};
    this.attl = attl;
    this.nsttl = nsttl;
    this.anum = 0;

    // decode request
    var index = 12;
    this.name = '';

    // decode query
    var qc = msg.readUInt16BE(4);
    if (qc > 0) {
      var antiloop = 15;
      while (msg[index] !== 0) {
        var count = msg[index++];
        antiloop--;
        if (antiloop < 1) { throw "Incorrect DNS request. Cnt: " + count + " idx: " + index; }
        this.name += msg.slice(index, index + count).toString() + (msg[index + count]?'.':'');
        index += count;
      }
      index++;
      this.qtype = msg.readUInt16BE(index);
      index += 2;
      this.qclass = msg.readUInt16BE(index);
      index += 2;
    }
    var qclen = index - 12;
    while (qc > 1) { // forget useless requests.
      while (msg[index] !== 0) { index++ }
      index += 5;
      qc--;
    }

    // decode EDNS (ECS)
    this.ecs = false;
    while (index < msg.length) {
      while (msg[index] !== 0) { index++ }
      var rdlength = msg.readUInt16BE(index + 9);
      if (msg.readUInt16BE(index + 1) === DNSConsts.QTYPE.OPT) {
        this.edns = true;
        this.ednsrecord = msg.slice(index, index + rdlength + 11);
        if (msg[index + 12] === 8) {
          this.ecs = true;
          this.ecsnet = this.calcecsnet(this.ednsrecord.slice(15, rdlength + 11));
        }
      }
      index += 12 + rdlength;
    }

    // initialize response
    this.buff = new Buffer.allocUnsafe(512);
    this.curpos = 0;

    // header
    this.adds16b(msg.readUInt16BE(0)); // ID
    this.adds16b(0x8500); // set AA, RD, no error.
    this.rcode = 0;
    this.adds16b(1); // Query count 1
    this.adds16b(0); // Answer count
    this.adds16b(0); // Auth count
    this.adds16b(0); // Additional count

    // query
    this.addsname(this.name);
    this.adds16b(this.qtype);
    this.adds16b(this.qclass);

    return this;
  }

  // set response code
  setresponsecode(rcode) {
    this.rcode = rcode;
    this.buff.writeUInt8(this.buff.readUInt8(3) & 0xF8 | rcode, 3);
  }

  // adds A record
  addsArecord(type, name, ip) {
    this.inccounter(type);
    this.addsname(name);
    this.adds16b(DNSConsts.QTYPE.A);
    this.adds16b(1); // Class IN
    this.adds32b(this.attl);
    this.adds16b(4); // RDLength 4
    this.adds32b(ip);
  }

  // adds AAAA record
  addsAAAArecord(type, name, ip) {
    this.inccounter(type);
    this.addsname(name);
    this.adds16b(DNSConsts.QTYPE.AAAA);
    this.adds16b(1); // Class IN
    this.adds32b(this.attl);
    this.adds16b(16); // RDLength 16 
    ip.copy(this.buff, this.curpos);
    this.curpos += 16;
  }

  // adds CNAME record
  addsCNAMErecord(type, name, data) {
    this.inccounter(type);
    this.addsname(name);
    this.adds16b(DNSConsts.QTYPE.CNAME);
    this.adds16b(1); // Class IN
    this.adds32b(this.attl);
    var memolength = this.curpos;
    this.adds16b(0); // RDLength 0
    this.addsname(data);
    this.buff.writeUInt16BE(this.curpos - memolength - 2, memolength); // Fix RDLength
  }

  // adds NS record
  addsNSrecord(type, name, data) {
    this.inccounter(type);
    this.addsname(name);
    this.adds16b(DNSConsts.QTYPE.NS);
    this.adds16b(1); // Class IN
    this.adds32b(this.nsttl);
    var memolength = this.curpos;
    this.adds16b(0); // RDLength 0
    this.addsname(data);
    this.buff.writeUInt16BE(this.curpos - memolength - 2, memolength); // Fix RDLength
  }

  // adds SOA record
  addsSOArecord(type, name, primary) {
    this.inccounter(type);
    this.addsname(name);
    this.adds16b(DNSConsts.QTYPE.SOA);
    this.adds16b(1); // Class IN
    this.adds32b(this.nsttl);
    var memolength = this.curpos;
    this.adds16b(0); // RDLength 0 (will be fixed later).
    this.addsname(primary);
    this.addsname("francois.veux.name"); // admin
    this.adds32b(2018051920); // serial
    this.adds32b(43200); // refresh
    this.adds32b(3600); // retry
    this.adds32b(1209600); // expiration
    this.adds32b(600); // minimum
    this.buff.writeUInt16BE(this.curpos - memolength - 2, memolength); // Fix RDLength
  }

  // adds EDNS-ECS record
  addsednsecs(mask) {
    this.inccounter('additional');
    this.ednsrecord.writeUInt16BE(512,3); // Max UDP size 512, everytime enougth for cdnboxd.
    this.ednsrecord[18] = mask;
    this.ednsrecord.copy(this.buff, this.curpos);
    this.curpos += this.ednsrecord.length;
  }

  // encode a 16 bit number
  inccounter(type) {
    switch (type) {
      case 'answer':
        this.buff.writeUInt16BE(this.buff.readUInt16BE(6) + 1, 6);
        this.anum++;
        break;
      case 'authority':
        this.buff.writeUInt16BE(this.buff.readUInt16BE(8) + 1, 8);
        break;
      case 'additional':
        this.buff.writeUInt16BE(this.buff.readUInt16BE(10) + 1, 10);
        break;
    }
  }

  // encode a 16 bit number
  adds16b(n) {
    this.buff.writeUInt16BE(n, this.curpos);
    this.curpos += 2;
  }

  // encode a 32 bit number
  adds32b(n) {
    this.buff.writeUInt32BE(n, this.curpos);
    this.curpos += 4;
  }

  // encode a name
  addsname(str) {
    var offset, dot, part;
    while (str) {
      if (this.dico[str]) {
        offset = 0xC000 + this.dico[str];
        this.buff.writeUInt16BE(offset, this.curpos);
        this.curpos += 2;
        break;
      } else {
        this.dico[str] = this.curpos;
        dot = str.indexOf('.');
        if (dot > -1) {
          part = str.slice(0, dot);
          str = str.slice(dot + 1);
        } else {
          part = str;
          str = undefined;
        }
        this.buff.writeUInt8(part.length, this.curpos++);
        this.buff.write(part, this.curpos, part.length, 'ascii');
        this.curpos += part.length;
      }
    }
    if (!str) {
      this.buff.writeUInt8(0, this.curpos++);
    }
  }

  // returns buffer
  getbuff() { return this.buff.slice(0, this.curpos); }

  // decodage de l'adresse EDNS.
  calcecsnet(data) {
    var proto = data.readUInt16BE(0);
    this.ecsmask = data[2];
    if (proto == 1 && (this.ecsmask >= 17 && this.ecsmask <= 24)) {
      return '' +  data[4] + '.' + data[5] + '.' +  data[6] + '.0';
    } else if (proto == 1 && this.ecsmask >= 25) {
      return '' +  data[4] + '.' + data[5] + '.' +  data[6] + '.' + data[7];
    } else if (proto == 2 && this.ecsmask == 56) {
      return data.toString('hex', 4, 6) + ':' + data.toString('hex', 6, 8) + ':' + 
             data.toString('hex', 8, 10) + ':' + data.toString('hex', 10, 11) + '00::';
    }
    console.error("EDNS: proto %s ou ecsmask %s inconnu", proto, this.ecsmask);
    return null;
  }
}
module.exports = cdnboxDNSPacket;

