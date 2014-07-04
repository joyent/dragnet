#!/bin/bash

#
# test.index_fileset_daily.sh: tests creating daily indexes on top of hourly
# ones.
#

function list_indexes
{
	(cd $tmpdir && find . -type f | sort)
}

set -o errexit
. $(dirname $0)/common.sh

tmpdir="/var/tmp/$(basename $0).$$"
fields='timestamp[date;field=time;aggr=lquantize;step=3600],host,operation,req.caller,req.method,latency[aggr=quantize]'
dayfields='timestamp[aggr=lquantize;step=3600],host,operation,req.caller,req.method,latency[aggr=quantize]'
echo "using tmpdir \"$tmpdir" >&2

echo "creating hourly index" >&2
dn index --counters -c "$fields" -R $DN_DATADIR -I "$tmpdir" 2>&1
list_indexes

# simple query
dn query -I "$tmpdir" --counters -b host,operation 2>&1

# generate daily indexes from raw files
echo "creating daily indexes from raw files" >&2
dn index --counters --interval=day -c "$fields" \
    -R $DN_DATADIR -I "$tmpdir" 2>&1
list_indexes

# repeat simple query
dn query -I "$tmpdir" --counters -b host,operation 2>&1

# remove the daily indexes and make sure they're gone
rm -rf "$tmpdir/by_day"
list_indexes
dn query -I "$tmpdir" --counters -b host,operation 2>&1

# generate daily indexes again, this time using the hourly indexes
echo "creating daily indexes from hourly indexes" >&2
dn index --counters --interval=day --source=hour \
    -c "$dayfields" -R $DN_DATADIR -I "$tmpdir" 2>&1
list_indexes
dn query -I "$tmpdir" --counters -b host,operation 2>&1

# run a query using filters, --before, and --after, too.
dn query -I "$tmpdir" --counters -f '{ "eq": [ "host", "ralph" ] }' \
    --time-field=timestamp --after=2014-05-03T12:00:00 \
    --before=2014-05-03T18:00:00 2>&1

rm -rf "$tmpdir"