#!/usr/bin/env python3
"""Ask the Ark operator whether it tolerates gRPC keepalive pings.

wavelength#1044 gives waved a 30s keepalive ping with
PermitWithoutStream, so it pings even with no RPC in flight. The review
thread on that PR (comment 3634720123) established that neither lumosd
nor swapdk-server had a grpc.KeepaliveEnforcementPolicy at the time, so
both fell back to grpc-go's default: MinTime 5m, PermitWithoutStream
false. Under that default an idle ping is a strike, and two strikes earn
GOAWAY with ENHANCE_YOUR_CALM and debug data "too_many_pings". lumos#699
adds MinTime 15s with PermitWithoutStream true; it is a private
repository, so we cannot read whether the signet operator runs it.

This probe answers that from the outside. It speaks raw HTTP/2 because a
gRPC keepalive ping is nothing more than a PING frame on stream 0. It
opens no streams and makes no RPC, so it needs no credentials and moves
no money.

What discriminates the two policies is subtler than it first looks, and
an earlier version of this script got it wrong. grpc-go's server sends
GOAWAY on the third strike (maxPingStrikes is 2, and it fires on
strikes > 2), so any run of fewer than 4 pings survives both policies and
proves nothing. Worse, defaultPingTimeout is 2 hours, not 2 seconds: with
PermitWithoutStream false, every streamless ping after the first strikes
regardless of how far apart they are. Ping spacing only matters once
PermitWithoutStream is true, where MinTime applies.

So the test is: send at least 4 pings with no stream open.

  no GOAWAY  - PermitWithoutStream must be true, whatever the interval,
               because the default policy would have struck on every ping
               and ended it on the fourth. The enforcement policy is
               deployed and a build carrying #1044 is safe here.
  GOAWAY     - strikes accumulated. That proves the default policy only
               if the interval is comfortably above any plausible
               MinTime; at a fast interval it says nothing, since a
               15s MinTime is violated too.

Usage:
  python3 scripts/operator-keepalive-probe.py [host[:port]] [--interval S] [--pings N]

Defaults to the signet operator, a 30s interval and 6 pings. 30s is what
waved on main sends; 6 is two more than the minimum that can conclude.
"""

import argparse
import select
import socket
import ssl
import struct
import sys
import time

PREFACE = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"

FRAME_SETTINGS = 0x4
FRAME_PING = 0x6
FRAME_GOAWAY = 0x7

FLAG_ACK = 0x1

# grpc-go's http2_server: maxPingStrikes is 2 and GOAWAY fires on
# strikes > 2, so the fourth streamless ping is the earliest that can end
# a connection. Anything shorter cannot conclude.
MAX_PING_STRIKES = 2

# HTTP/2 error codes we care about naming in the output.
ERROR_CODES = {
    0x0: "NO_ERROR",
    0x1: "PROTOCOL_ERROR",
    0x2: "INTERNAL_ERROR",
    0xB: "ENHANCE_YOUR_CALM",
}


def frame(frame_type, flags, stream_id, payload=b""):
    """Serialise one HTTP/2 frame."""
    header = struct.pack(">I", len(payload))[1:]
    header += struct.pack(">BBI", frame_type, flags, stream_id)
    return header + payload


def read_frames(buffer):
    """Split a byte buffer into complete frames.

    Returns the leftover buffer alongside the frames so the caller can
    keep a partial frame across reads.
    """
    frames = []
    while True:
        if len(buffer) < 9:
            break
        length = int.from_bytes(buffer[0:3], "big")
        if len(buffer) < 9 + length:
            break
        frame_type, flags, stream_id = struct.unpack(">BBI", buffer[3:9])
        payload = buffer[9 : 9 + length]
        frames.append((frame_type, flags, stream_id & 0x7FFFFFFF, payload))
        buffer = buffer[9 + length :]
    return frames, buffer


def describe_goaway(payload):
    """Render a GOAWAY payload as (code name, debug text)."""
    if len(payload) < 8:
        return "malformed", ""
    _, code = struct.unpack(">II", payload[:8])
    debug = payload[8:].decode("utf-8", "replace")
    return ERROR_CODES.get(code, f"0x{code:x}"), debug


def probe(host, port, interval, pings):
    context = ssl.create_default_context()
    context.set_alpn_protocols(["h2"])

    raw = socket.create_connection((host, port), timeout=15)
    sock = context.wrap_socket(raw, server_hostname=host)

    negotiated = sock.selected_alpn_protocol()
    print(f"connected to {host}:{port}, alpn={negotiated}")
    if negotiated != "h2":
        print("endpoint did not negotiate h2; this is not a gRPC listener")
        return 2

    sock.sendall(PREFACE + frame(FRAME_SETTINGS, 0, 0))

    buffer = b""
    sent = 0
    acked = 0
    next_ping = time.monotonic()
    # Give the last ping a full interval to earn a GOAWAY before giving up.
    deadline = time.monotonic() + interval * (pings + 1) + 10
    started = time.monotonic()

    while time.monotonic() < deadline:
        now = time.monotonic()
        if sent < pings and now >= next_ping:
            sock.sendall(frame(FRAME_PING, 0, 0, struct.pack(">Q", sent + 1)))
            sent += 1
            print(f"[{now - started:6.1f}s] ping {sent}/{pings} sent")
            next_ping = now + interval

        timeout = min(1.0, max(0.0, deadline - now))
        readable, _, _ = select.select([sock], [], [], timeout)
        if not readable:
            continue

        chunk = sock.recv(65536)
        if not chunk:
            print(f"[{time.monotonic() - started:6.1f}s] connection closed by peer")
            print("\nresult: rejected (closed without GOAWAY)")
            return 1

        buffer += chunk
        frames, buffer = read_frames(buffer)
        for frame_type, flags, _, payload in frames:
            stamp = time.monotonic() - started
            if frame_type == FRAME_SETTINGS and not flags & FLAG_ACK:
                sock.sendall(frame(FRAME_SETTINGS, FLAG_ACK, 0))
            elif frame_type == FRAME_PING and flags & FLAG_ACK:
                acked += 1
                print(f"[{stamp:6.1f}s] ping ack {acked}")
            elif frame_type == FRAME_GOAWAY:
                code, debug = describe_goaway(payload)
                print(f"[{stamp:6.1f}s] GOAWAY {code} {debug!r}")
                if "too_many_pings" not in debug:
                    print("\nresult: inconclusive. GOAWAY for another reason.")
                elif interval >= 30:
                    print(
                        f"\nresult: rejected. Struck at a {interval}s interval, "
                        "which is above any plausible MinTime, so grpc-go's "
                        "default policy (PermitWithoutStream false) is in force. "
                        "A build carrying wavelength#1044 would churn its "
                        "connection against this operator rather than detect a "
                        "dead one."
                    )
                else:
                    print(
                        f"\nresult: inconclusive. A {interval}s interval violates "
                        "the default policy and a 15s MinTime alike, so the "
                        "strike does not tell them apart. Re-run at 30s."
                    )
                return 1

        if sent == pings and acked >= pings:
            # Every ping was answered. Wait out the remaining budget in
            # case a GOAWAY is still coming, then call it accepted.
            if time.monotonic() - started > interval * pings + 5:
                break

    if sent <= MAX_PING_STRIKES + 1:
        print(
            f"\nresult: inconclusive. {sent} pings cannot separate the two "
            f"policies, since GOAWAY only fires on strike "
            f"{MAX_PING_STRIKES + 1}. Re-run with at least "
            f"{MAX_PING_STRIKES + 2}."
        )
        return 2

    print(
        f"\nresult: accepted. {acked}/{sent} pings answered with no stream "
        "open and no GOAWAY. The default policy would have struck on every "
        "ping and ended it on the fourth, so PermitWithoutStream is true and "
        "the enforcement policy is deployed. A build carrying "
        "wavelength#1044 would be safe against this operator."
    )
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "target",
        nargs="?",
        default="signet.wavelength.lightning.finance:443",
        help="host[:port] to probe (default: the signet Ark operator)",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=30.0,
        help="seconds between pings (default 30, what waved on main sends)",
    )
    parser.add_argument(
        "--pings",
        type=int,
        default=6,
        help=f"how many pings to send (default 6; fewer than "
        f"{MAX_PING_STRIKES + 2} cannot conclude)",
    )
    args = parser.parse_args()

    host, _, port = args.target.partition(":")
    return probe(host, int(port or 443), args.interval, args.pings)


if __name__ == "__main__":
    sys.exit(main())
