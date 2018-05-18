// Copyright 2011 Timothy J Fontaine <tjfontaine@gmail.com>
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

class cdnboxPacket {

  constructor(msg) {

    var index = 0;

    // decode request
    var qc = msg.readUInt16BE(4);
    if (qc > 0) {
      index = 12;
      this.name = '';
      while (msg[index] !== 0) {
        var count = msg[index++];
        this.name += msg.slice(index, index + count).toString() + (msg[index + count]?'.':'');
        index += count;
      }
      index++;
      this.qtype = msg.readUInt16BE(index);
      index += 4;
    }
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
      if (msg.readUInt16BE(index + 1) === 41) {
        this.edns = true;
        this.ednsrecord = msg.slice(index, index + rdlength + 11);
        if (msg[index + 12] === 8) {
          this.ecs = true;
          this.ecsnet = ecsnet(this.ednsrecord.slice(15, rdlength + 11));
        }
      }
      index += 12 + rdlength;
    }

//    this.index = index;
//    this.length = msg.length;
    return this;
  }

}
module.exports = cdnboxPacket;


// decodage de l'adresse EDNS.
function ecsnet(data) {
  var proto = data.readUInt16BE(0), subnetl = data[2];
  if (proto == 1 && (subnetl >= 17 && subnetl <= 24)) {
    return '' +  data[4] + '.' + data[5] + '.' +  data[6] + '.0';
  } else if (proto == 1 && subnetl >= 25) {
    return '' +  data[4] + '.' + data[5] + '.' +  data[6] + '.' + data[7];
  } else if (proto == 2 && subnetl == 56) {
    return data.toString('hex', 4, 6) + ':' + data.toString('hex', 6, 8) + ':' + 
           data.toString('hex', 8, 10) + ':' + data.toString('hex', 10, 11) + '00::';
  }
  console.error("EDNS: proto %s ou subnetl %s inconnu", proto, subnetl);
  return null;
}


var LABEL_POINTER = 0xC0;

var isPointer = function(len) {
  return (len & LABEL_POINTER) === LABEL_POINTER;
};

function unpack(buff) {
  var len, comp, end, pos, part, combine = '';

  len = buff.readUInt8();
  comp = false;
  end = buff.tell();

  while (len !== 0) {
    if (isPointer(len)) {
      len -= LABEL_POINTER;
      len = len << 8;
      pos = len + buff.readUInt8();
      if (!comp)
        end = buff.tell();
      buff.seek(pos);
      len = buff.readUInt8();
      comp = true;
      continue;
    }

    part = buff.toString('ascii', len);

    if (combine.length)
      combine = combine + '.' + part;
    else
      combine = part;

    len = buff.readUInt8();

    if (!comp)
      end = buff.tell();
  }

  buff.seek(end);

  return combine;
}

exports.pack = function (str, buff, index) {
  var offset, dot, part;

  while (str) {
    if (index[str]) {
      offset = (LABEL_POINTER << 8) + index[str];
      buff.writeUInt16BE(offset);
      break;
    } else {
      index[str] = buff.tell();
      dot = str.indexOf('.');
      if (dot > -1) {
        part = str.slice(0, dot);
        str = str.slice(dot + 1);
      } else {
        part = str;
        str = undefined;
      }
      buff.writeUInt8(part.length);
      buff.write(part, part.length, 'ascii');
    }
  }

  if (!str) {
    buff.writeUInt8(0);
  }
}

