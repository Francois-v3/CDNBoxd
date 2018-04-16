# CDNBoxd
A DNS distributed Global Load Balancing with geolocation and bandwith shaping.

CDNBox is a solution to mix private CDN with legacy CDN. CDNBoxd is originaly the specific software used to clusterize multiple CDNBoxes. Nowdays, CDNBoxd is used out of CDNBox solution, to distribute load on Edge endpoints for example.
To keep it simple, a CDNBox is a node of CDNBoxd.

## Features

* DNS load balancer
* Distribute DNS/HTTP trafic based on geolocaion and performance.
* Based on resolver geolocation or EDNS client geolocation if available.
* Limit bandwith by node with a global saturation indicator.
* Alerting based on error rate.
* Logging to elasticsearch thru rsyslog.
* API for monitoring and configuration changes.
* Client side DNS resolution et connection measurment based on Resource Timing.
* UI
* varnishstat metric collector.
* CDNBox's local service testing (HTTP).

## How to install

* git clone
* npm install
* download GeoLite2 Country from https://dev.maxmind.com/geoip/geoip2/geolite2/ and copy GeoLite2-Country.mmdb into CDNBoxd directory
* copy config-template.json to config.json and change it to your settings.
* edit cdnboxd.service file changing <home> to your directory.
* install cdnboxd.service into systemd
* start CDNBoxd with "systemctl start cdnboxd.service"

Repeat for each node.

## Configuation file

All fields with default value are optionnal. Config is exactly the same on each node.

```javascript
  "dnsserver": { 
     "domain": domain answered, any request to other domain will not be answered,
     "port": DNS port, default to 53,
     "nsnum": number of NS record,
     "nsttl": ttl for NS and SOA records (second),
     "attl": ttl for A and AAAA records (second), 
     "dnscountdownratio" : global request rate reduction ratio (default to 1.2).
     "dnscountavgmin": minimum global request rate by node (default to 1.5).
     "globalthrottlelimit": global request rate growup ratio to throttle (default to 2).
     "globalthrottlebwratio": targetbw ratio to activate global request throttle (default to 0.4).
  },
  "httpserver": {
     "port": HTTP port,
     "authorization": HTTP credential (Basic xxxxxx)
  },
  "states": { 
     "penalgdown": reduction of global saturation indicator period (default to 120)
  },
  "perf": { // optional
    "domain": domain to mesure,
    "beaconurl": beacon URL prefix,
    "delay": time to start measurment,
    "weights": measurment weight by country (percentage), ex: { "FR": 50, "default": 100 },
  },

  "varnishmetrics": {  // optional
    "es_name": "varnish_name", define a varnish metric. varnish_name is the varnishstat entry name. es_name is
        the json name sent to ES.
    ...
  },

  "cdnboxes": [
    { "name": node's name ,
      "hostname": node's hostname without final dot,
      "countries": node's country localisation, "ALL" or array of countries like [ "US", "CA" ],
      "continents": node's continent localisation, array like [ "EU", "NA" ]. For NS records order, we use array of countries, then continent, then country "ALL". For A and AAAA records, we use continents only if no conntries are defined.
      "proto": "http:" ou "https:", default protocol for this CDNBox (default to HTTPS),
      "isns": is this CDNBox is a DNS server (default to false),
      "cname": serve CNAME record instead of A or AAAA, (default to false),
      "penal": pénalité initiale, 100 par défaut.
      "ishttp": is this CDNBox serve HTTP (other than CDNBoxd trafic itself),
      "status": initial HTTP trafic status (on/off),
      "targetbw": target bandwith for this node,
      "floorbw": floor bandwith targetbw ratio to start reducing bandwith (default to 0.9).
      "ceilbw": ceil bandwith targetbw ratio to stop trafic, (default to 1.1).
      "perfURL": performance measurment URL (default to <proto>://<hostname>/cdn/image.gif),
      "addscore": add a fixed value to performance (millisecond, default to 0),
      "fixscore": set a fixed value to performance (desactivate performance measurment),
      "dnsthrottlebwratio" : définit le ratio de targetbw high/low de blocage des requêtes DNS.
      "dnsthrottlelowratio" : active et définit le ratio low de blocage des requêtes DNS.
      "dnsthrottlehighratio" : active et définit le ratio high de blocage des requêtes DNS.
      "nspriorityratio" : coefficient de biais d'un la liste des NS. 1 par défaut. 0 = priorité maximale.
      "nsgroup" : si définit, assure qu'il y a au moins 2 group dans la liste des NS.
      "varnishmetrics": if true, we collect varnishstate metric defined in "varnishmetrics".
      "localtests": définit des test locaux. [
        { "name": "apache", "url": "http://127.0.0.1:8080/" },
        ... 
      ],
      "notification": { si présent, active les notifications d'erreur sur cette CDNBox.
        "email": emails destinataires.
        "threshold": seuil de déclenchement des alertes (nombre sur période).
        "period": période pour le seuil de déclenchement des alertes.
        "lastmessagenumber": nombre de dernières erreurs dans le corp du message.
        "remindertime": délai avant de rappeler un état d'alerte.
      }
    },
    { ...
    }
  ],

  "applis": [
    "a1": [
      {
        // first node will be serve if none of the other match.
        "cdnbox": "ABC-victim2" node's name,
        "addscore": change addscore for this node in this application,
        "fixscore": change fixscore for this node in this application,
        "countries": surcharge le countries soit "ALL", soit [ "US", "CA" ],
        "continents": surcharge les continents de la CDNbox, sous forme [ "EU", "NA" ]. 
        "localtests": COnditionne sur des tests locaux. [ "apache", ... ]
      },
      { ...
      }
    ],
    "a2": [
      { ...
      },
      { ...
      }
    ]
  ]
```

## API

## Sample

Serve www.mydomain.org on a hybrid CDN with one legacy CDN (legacycdn.mydomain.org) and two Vanish boxes.

Config file (config-template.json) is:
```javascrit
{
  "dnsserver": { "domain": "cdnboxd.mydomain.org", "port": 53, "nsnum": 2, "nsttl": 3600, "attl": 20 },
  "httpserver": { "port": 1080, "authorization": "Basic XXXXXXXXXX==" },
  "states": { "penalgdown": 60 },
  "perf": {
    "domain": "www.mydomain.org",
    "beaconurl": "http://test.mydomain.org",
    "delay": 5000,
    "weights": { "FR": 50, "default": 100 }
  },
  "varnishmetrics": {
    "sess_conn": "MAIN.sess_conn",
    "client_req": "MAIN.client_req",
    "g_bytes": "SMA.s0.g_bytes",
    "g_space": "SMA.s0.g_space"
  },
  "cdnboxes": [
    {
      "name": "Node1", "hostname": "node1.mydomain.org",
      "targetbw": 500,
      "countries": [ "FR", "BE" ],
      "isns": true
    },
    {
      "name": "Node2", "hostname": "node2.mydomain.org",
      "targetbw": 500,
      "countries": [ "FR", "BE" ],
      "isns": true
    },
    {
      "name": "Node3", "hostname": "legacycdn.mydomain.org",
      "fixscore": 1000,
      "countries": "ALL",
      "isns": false, "cname": true
    }
  ],
  "applis": {
    "a1": [
      { "cdnbox": "Node3" },
      { "cdnbox": "Node1" },
      { "cdnbox": "Node2" }
    ],
    "test": [
      { "cdnbox": "Node1", "fixscore": 1000, "countries": "ALL" },
      { "cdnbox": "Node1" },
      { "cdnbox": "Node2" }
    ]
  }
}
```

DNS records:

* cdnboxd.mydomain.org IN NS node1.mydomain.org.
* cdnboxd.mydomain.org IN NS node2.mydomain.org.
* www.mydomain.org IN CNAME a1.cdnboxd.mydomain.org.
* test.mydomain.org IN CNAME test.cdnboxd.mydomain.org.


