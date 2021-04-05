#!/bin/bash

# go to homedir.
cd $CDNBOXDDIR
# prefer local node if available
PATH=".:$PATH"
# launch node loging output directly to syslog
export UV_THREADPOOL_SIZE=16
node --min_semi_space_size=20 lib/cdnboxd.js >> /var/log/cdnboxd.log &
