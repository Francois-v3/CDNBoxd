# CDNBoxd
A DNS distributed Global Load Balancing with geolocation and bandwith shaping.

## Features

* DNS load balancer
* Limit bandwith by node
* GeoLocation
* EDNS support for Geolocation.
* alerting based in error rate.
* logging to elasticsearch thru rsyslog.

## How to install

* git clone
* download GeoLite2 Country from https://dev.maxmind.com/geoip/geoip2/geolite2/ into CDNBoxd directory
* edit the configuration file
* edit cdnboxd.service file
* install cdnboxd.service into systemd
* start CDNBoxd with systemctl start cdnboxd.service

## Configuation file

```javascript
  "dnsserver": { 
     "domain": domain answered, any request to other domain will not be answered,
     "port": DNS port, default to 53,
     "nsnum": number of NS record,
     "nsttl": ttl for NS and SOA records (second),
     "attl": ttl for A and AAAA records (second), 
     "dnscountdownratio" : ratio de réduction des requêtes DNS globales (par défaut 1.2).
     "dnscountavgmin": débit moyen minimum. 1.5 par défaut.
     "globalthrottlelimit": limite de croissante de blocage global des requêtes, par défaut 2.
     "globalthrottlebwratio": ratio de targetbw pour déclenchement de blocage global des requêtes, par défaut 0.4.

  "httpserver": {
     "port": port d'écoute HTTP,
     "authorization": chaine d'autorisation pour les accès restreints },

  "states": { 
     "penalgdown": période de reduction de la penalite globale en s (préco 60) },

  "perf": {
    "domain": domaine des objets à surveiller,
    "beaconurl": prefixe de l'URL de beacon,
    "delay": délai d'exécution après chargement,
    "weights": liste des poids de mesure par pays, ex: { "FR": 50, "default": 100 },
  },

  "varnishmetrics": {
    "es_name": "varnish_name", define a varnish metric. varnish_name is the varnishstat entry name. es_name is
        the json name sent to ES.
    ...
  },

  "cdnboxes": [
    { "name": nom de la cdnbox ,
      "hostname": nom DNS de la cdnbox sans point final,
      "countries": localisation de la CDNbox, soit "ALL", soit [ "US", "CA" ],
      "continents": localisation de la CDNbox, sous forme [ "EU", "NA" ]. Pour les NS, on utilise dans l'ordre:
          les pays, les continents, puis les countries "ALL". Pour la résolution, on utilise les continents à
          défaut de pays.
      "proto": "http:" ou "https:", protocole pour la mesure de BP (CDNBox remote). Https par défaut,
      "isns": indique si la CDNBox est server DNS. (false par défaut),
      "cname": indique s'il faut servir un cname plutôt que A ou AAAA, false par défaut,
      "penal": pénalité initiale, 100 par défaut.
      "ishttp": si false la box ne sert pas de trafic (HTTP),
      "status": si on/off  active/desactive le trafic (HTTP) si ishttp est à true,
      "targetbw": bande passante cible,
      "floorbw": seuil inférieur bande passante régulée, 90% de targetbw par défaut.
      "ceilbw": seuil supérieur bande passante régulée, 110% de targetbw par défaut.
      "addscore": ajout d'une valeur fixe au score (somme perf et addscore),
      "fixscore": définit un score fixe (pas de mesure de performance),
      "perfURL": url de mesure de performance (par défaut <proto>://<hostname>/cdn/image.gif),
      "dnsthrottlebwratio" : définit le ratio de targetbw high/low de blocage des requêtes DNS.
      "dnsthrottlelowratio" : active et définit le ratio low de blocage des requêtes DNS.
      "dnsthrottlehighratio" : active et définit le ratio high de blocage des requêtes DNS.
      "nspriorityratio" : coefficient de biais d'un la liste des NS. 1 par défaut. 0 = priorité maximale.
      "nsgroup" : si définit, assure qu'il y a au moins 2 group dans la liste des NS.
      "varnishmetrics": si définit (true), remonte des metriques varnish.
      "localtests": définit des test locaux. [ { "name": "apache", "url": "http://127.0.0.1:8080/" }, ... ]
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
        "cdnbox": "ABC-victim2" nom de la CDNBoxes, // la première est par défaut inconditionnellement.
        "addscore": surcharge le addscore de la CDNBoxe si présent,
        "fixscore": surcharge le fixscore de la CDNBoxe si présent,
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

