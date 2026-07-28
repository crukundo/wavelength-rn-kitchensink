#!/bin/sh
# operator-blackhole.sh — silently drop traffic to the Ark operator, so the
# receive block described in docs/RECEIVE_BLOCK_ROOT_CAUSE.md can be
# reproduced on demand instead of waited for.
#
# The failure needs one condition: the request reaches the operator, the
# response never comes back, and the connection stays open so nothing
# notices. waved has no gRPC keepalive in v0.1.0, so the caller waits out
# the 10 minute response-waiter TTL and dies with "response waiter expired".
#
# Packets are dropped, not rejected. A reject sends a TCP reset, the client
# re-dials at once, and you have tested the case gRPC already handles.
#
# The mailbox is store and forward: Edge.Send is a short RPC that hands the
# envelope over, and the reply returns later through the ingress pull loop.
# So a blackhole starting a second into a receive call leaves the send
# already delivered and the response unable to return.
#
# This is host-wide. Every simulator on this machine loses the operator, so
# a second wallet is not a valid control while it is on.
#
# Usage:
#   sudo scripts/operator-blackhole.sh on
#   sudo scripts/operator-blackhole.sh off
#   sudo scripts/operator-blackhole.sh status
#   sudo scripts/operator-blackhole.sh window <delay_s> <hold_s>
#
# window sleeps delay_s, blocks for hold_s, then restores. Use it to time a
# blackhole against a probe run without racing the clock by hand.

set -eu

HOST="signet.wavelength.lightning.finance"
PORT=443
ANCHOR="com.apple/wavelength-blackhole"
TOKEN_FILE="/tmp/wavelength-pf.token"

usage() {
	echo "usage: $0 {on|off|status|window <delay_s> <hold_s>}" >&2
	exit 64
}

require_root() {
	if [ "$(id -u)" -ne 0 ]; then
		echo "$0 needs root for pfctl. Re-run with sudo." >&2
		exit 77
	fi
}

# resolve prints the operator's current IPv4 addresses. The name is a CNAME
# to lumosd-signet.staging.lightningcluster.com behind a load balancer, so
# the set changes; always resolve at block time rather than hardcoding.
resolve() {
	dig +short "$HOST" A | grep -E '^[0-9]+(\.[0-9]+){3}$' || true
}

on() {
	require_root

	ips=$(resolve)
	if [ -z "$ips" ]; then
		echo "could not resolve $HOST" >&2
		exit 69
	fi

	# pf only evaluates anchors reachable from the main ruleset. macOS ships
	# /etc/pf.conf with `anchor "com.apple/*"`, so nesting under com.apple
	# means no edit to the system config.
	{
		printf 'table <wl_op> persist { '
		echo "$ips" | tr '\n' ' '
		printf '}\n'
		echo "block drop out quick proto tcp to <wl_op> port $PORT"
	} | pfctl -a "$ANCHOR" -f - 2>/dev/null

	# -E enables pf with a reference count and prints a token, so turning
	# this off later does not disable pf for anything else that wants it.
	if [ ! -f "$TOKEN_FILE" ]; then
		pfctl -E 2>&1 | awk '/Token :/ { print $3 }' > "$TOKEN_FILE"
	fi

	echo "blackholed $HOST:$PORT"
	echo "$ips" | sed 's/^/  /'
}

off() {
	require_root

	pfctl -a "$ANCHOR" -F all 2>/dev/null || true

	if [ -f "$TOKEN_FILE" ]; then
		token=$(cat "$TOKEN_FILE")
		[ -n "$token" ] && pfctl -X "$token" >/dev/null 2>&1 || true
		rm -f "$TOKEN_FILE"
	fi

	echo "restored $HOST:$PORT"
}

status() {
	echo "host:    $HOST:$PORT"
	echo "resolves:"
	resolve | sed 's/^/  /'
	echo "anchor $ANCHOR:"
	pfctl -a "$ANCHOR" -s rules 2>/dev/null | sed 's/^/  /' || echo "  (none)"
	if [ -f "$TOKEN_FILE" ]; then
		echo "pf reference token held: $(cat "$TOKEN_FILE")"
	fi
}

case "${1:-}" in
on)
	on
	;;
off)
	off
	;;
status)
	status
	;;
window)
	[ $# -eq 3 ] || usage
	require_root
	delay=$2
	hold=$3
	# Restore even if interrupted. Leaving the operator blackholed is the
	# one outcome that wastes a whole session.
	trap 'off' INT TERM EXIT
	echo "waiting ${delay}s"
	sleep "$delay"
	on
	echo "holding ${hold}s"
	sleep "$hold"
	;;
*)
	usage
	;;
esac
